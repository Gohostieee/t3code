// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
// @effect-diagnostics nodeBuiltinImport:off
import { chromium, type Browser } from "playwright-core";
import * as Schema from "effect/Schema";
import {
  type AtlasCapture,
  type AtlasNode,
  type AtlasScenario,
  type AtlasTarget,
} from "@t3tools/contracts";

export const AtlasSessionState = Schema.Struct({
  cookies: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      value: Schema.String,
      domain: Schema.String,
      path: Schema.String,
      expires: Schema.Number,
      httpOnly: Schema.Boolean,
      secure: Schema.Boolean,
      sameSite: Schema.Literals(["Strict", "Lax", "None"]),
      partitionKey: Schema.optional(Schema.String),
    }),
  ),
  origins: Schema.Array(
    Schema.Struct({
      origin: Schema.String,
      localStorage: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
    }),
  ),
});
export type AtlasSessionState = typeof AtlasSessionState.Type;
export const atlasBrowserAvailable = () => NodeFS.existsSync(chromium.executablePath());
export const atlasCaptureFile = (stateDir: string, id: string, thumbnail = false) => {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid capture identity.");
  return NodePath.join(stateDir, "codebase-captures", `${id}${thumbnail ? "-thumb" : ""}.png`);
};

/** Cache eviction never removes source, sessions, or any file outside the owned capture directory. */
export async function pruneAtlasCaptures(stateDir: string) {
  const directory = NodePath.join(stateDir, "codebase-captures");
  const files = (await NodeFSP.readdir(directory, { withFileTypes: true }).catch(() => [])).filter(
    (entry) => entry.isFile() && /^[a-f0-9]{32}(?:-thumb)?\.png$/.test(entry.name),
  );
  const entries = await Promise.all(
    files.map(async (file) => ({
      name: file.name,
      ...(await NodeFSP.stat(NodePath.join(directory, file.name))),
    })),
  );
  let total = entries.reduce((sum, file) => sum + file.size, 0);
  const removed = new Set<string>();
  for (const entry of entries.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= 256 * 1024 * 1024) break;
    const id = entry.name.slice(0, 32);
    if (removed.has(id)) continue;
    for (const file of entries.filter((item) => item.name.startsWith(id))) {
      await NodeFSP.unlink(NodePath.join(directory, file.name)).catch(() => undefined);
      total -= file.size;
    }
    removed.add(id);
  }
}

export function atlasScenarioUrl(
  target: AtlasTarget,
  route: AtlasNode,
  scenario: AtlasScenario,
  privateValues: Readonly<Record<string, string>> = {},
) {
  const substitute = (value: string) => {
    if (!value.startsWith("@private:")) return value;
    const key = value.slice(9);
    if (!Object.hasOwn(privateValues, key))
      throw new Error(`Configure the private value ${key} in this environment.`);
    return privateValues[key]!;
  };
  let pattern = scenario.relativePath ?? route.pattern;
  if (!pattern) throw new Error("This route needs a relative target path.");
  for (const parameter of route.parameters) {
    const raw = scenario.parameters[parameter.name];
    const value = raw ? substitute(raw) : raw;
    if (!value && parameter.kind !== "optional-catch-all")
      throw new Error(`Supply a value for ${parameter.name}.`);
    const encoded =
      parameter.kind === "single"
        ? encodeURIComponent(value ?? "")
        : (value ?? "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
    pattern = pattern
      .replace(
        parameter.kind === "single"
          ? `[${parameter.name}]`
          : parameter.kind === "catch-all"
            ? `[...${parameter.name}]`
            : `[[...${parameter.name}]]`,
        encoded,
      )
      .replace(parameter.name === "_splat" ? "$" : `$${parameter.name}`, encoded);
  }
  if (!pattern.startsWith("/") || pattern.startsWith("//") || /[\\\[\]]/.test(pattern))
    throw new Error("Supply a valid relative route path.");
  const url = new URL(
    `${target.prefix.replace(/\/$/, "")}/${pattern.replace(/^\//, "")}`,
    target.origin,
  );
  if (url.origin !== new URL(target.origin).origin)
    throw new Error("A scenario cannot change the attached origin.");
  for (const [name, value] of Object.entries(scenario.query))
    url.searchParams.set(name, substitute(value));
  return url;
}

/** One owned browser per batch, isolated contexts per scenario; user preview tabs are untouched. */
export function makeAtlasCaptureRunner() {
  let browser: Browser | undefined;
  return {
    async close() {
      await browser?.close();
      browser = undefined;
    },
    async capture(input: {
      id: string;
      stateDir: string;
      target: AtlasTarget;
      route: AtlasNode;
      scenario: AtlasScenario;
      session?: AtlasSessionState;
      privateValues?: Readonly<Record<string, string>>;
      signal: AbortSignal;
    }): Promise<{ outcome: AtlasCapture["outcome"]; detail: string; available: boolean }> {
      const { scenario } = input;
      if (!scenario.readiness.value.trim())
        throw new Error("Configure visible text or a locator before capture.");
      const url = atlasScenarioUrl(input.target, input.route, scenario, input.privateValues);
      if (!atlasBrowserAvailable())
        return {
          outcome: "unavailable",
          detail: "Set up the capture browser in this environment first.",
          available: false,
        };
      browser ??= await chromium.launch({ headless: true, timeout: 30000 });
      const context = await browser.newContext({
        viewport:
          scenario.viewport === "desktop"
            ? { width: 1440, height: 900 }
            : { width: 390, height: 844 },
        colorScheme: scenario.theme,
        ...(input.session
          ? {
              storageState: {
                cookies: [...input.session.cookies],
                origins: input.session.origins.map((o) => ({
                  origin: o.origin,
                  localStorage: [...o.localStorage],
                })),
              },
            }
          : {}),
      });
      const abort = () => {
        void context.close();
      };
      input.signal.addEventListener("abort", abort, { once: true });
      const deadline = performance.now() + 30000;
      try {
        const page = await context.newPage();
        const response = await page.goto(url.toString(), {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        const observed = new URL(page.url());
        const expectedPath = scenario.expectedPath ?? url.pathname;
        if (
          observed.origin !== url.origin ||
          observed.pathname.replace(/\/$/, "") !== expectedPath.replace(/\/$/, "")
        )
          return {
            outcome: "unexpected-redirect",
            detail: `Navigation did not reach the expected path ${expectedPath}.`,
            available: false,
          };
        const status = response?.status() ?? 0;
        if (
          scenario.expectedStatus !== undefined
            ? status !== scenario.expectedStatus
            : status < 200 || status >= 400
        )
          return {
            outcome: "http-failure",
            detail: `HTTP ${status} did not match the expected outcome.`,
            available: false,
          };
        const locator =
          scenario.readiness.kind === "text"
            ? page.getByText(scenario.readiness.value, { exact: false }).first()
            : page.locator(scenario.readiness.value).first();
        try {
          await locator.waitFor({
            state: "visible",
            timeout: Math.max(1, deadline - performance.now()),
          });
        } catch {
          return {
            outcome: "readiness-failure",
            detail: "The scenario's readiness condition was not observed.",
            available: false,
          };
        }
        await NodeFSP.mkdir(NodePath.join(input.stateDir, "codebase-captures"), {
          recursive: true,
        });
        const full = await page.screenshot({
          type: "png",
          fullPage: false,
          animations: "disabled",
          timeout: Math.max(1, deadline - performance.now()),
        });
        if (full.byteLength > 8 * 1024 * 1024)
          throw new Error("Capture exceeds the 8 MiB image budget.");
        const viewport = page.viewportSize()!;
        const session = await context.newCDPSession(page);
        const thumb = await session.send("Page.captureScreenshot", {
          format: "png",
          clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale: 0.25 },
          captureBeyondViewport: false,
        });
        await NodeFSP.writeFile(atlasCaptureFile(input.stateDir, input.id), full);
        await NodeFSP.writeFile(
          atlasCaptureFile(input.stateDir, input.id, true),
          Buffer.from(thumb.data, "base64"),
        );
        return {
          outcome:
            scenario.expectedPath && observed.pathname !== url.pathname
              ? "expected-redirect"
              : status >= 400
                ? "expected-error"
                : "ready",
          detail:
            "Readiness assertion observed. Attached target is user-confirmed; running source remains unverified.",
          available: true,
        };
      } finally {
        input.signal.removeEventListener("abort", abort);
        await context.close();
      }
    },
  };
}
