// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeURL from "node:url";
// @effect-diagnostics nodeBuiltinImport:off
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId, type AtlasScenario } from "@t3tools/contracts";
import { resolveAsset } from "../src/assets/AssetAccess.ts";
import * as ServerSecretStore from "../src/auth/ServerSecretStore.ts";
import { ServerConfig } from "../src/config.ts";
import * as WorkspacePaths from "../src/workspace/WorkspacePaths.ts";
import { makeOrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";

const runtimeTest = process.env.T3_ATLAS_RUNTIME_ACCEPTANCE === "1" ? it.live : it.live.skip;
runtimeTest(
  "captures real Next server/client pages, private auth, redirects, empty and error states through environment asset delivery",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeOrchestrationIntegrationHarness();
      let closeApp = async () => {};
      yield* Effect.gen(function* () {
        const projectId = ProjectId.make("atlas-runtime");
        const origin = yield* Effect.promise(async () => {
          const root = harness.workspaceDir;
          await NodeFSP.symlink(
            NodeURL.fileURLToPath(new URL("../node_modules", import.meta.url)),
            NodePath.join(root, "node_modules"),
            "junction",
          );
          const files = {
            ".gitignore": "node_modules/\n.next/\n",
            "package.json":
              '{"name":"atlas-runtime-fixture","private":true,"dependencies":{"next":"16.4.3","react":"19.2.6","react-dom":"19.2.6"}}',
            "next.config.mjs":
              "export default { devIndicators: false, experimental: { cpus: 1 } };",
            "app/layout.jsx":
              "import './style.css'; export default function Layout({children}) { return <html><body><header>Atlas fixture shell</header>{children}</body></html> }",
            "app/style.css":
              "body{margin:0;background:#10151d;color:#e7edf5;font:20px system-ui}header{padding:24px;border-bottom:1px solid #344054}main{padding:40px}button{padding:12px 24px;background:#8db7ff;color:#10151d;border:0;border-radius:6px}",
            "app/page.jsx":
              "export default function Home(){return <main><h1>Atlas runtime fixture</h1></main>}",
            "app/Counter.jsx":
              "'use client'; import {useState} from 'react'; export default function Counter(){const [n,setN]=useState(0); return <button onClick={()=>setN(n+1)}>Updates: {n}</button>}",
            "app/projects/[id]/page.jsx":
              "import {cookies} from 'next/headers'; import {redirect} from 'next/navigation'; import Counter from '../../Counter'; export default async function Page({params,searchParams}) { const {id}=await params; const search=await searchParams; const session=await cookies(); if(session.get('atlas-member')?.value!=='yes') redirect('/login'); return <main><h1>{search.view==='empty'?'No projects yet':'Project '+id}</h1><Counter/><p>Rendered server data</p></main> }",
            "app/login/page.jsx":
              "export default function Login(){return <main><h1>Sign in to projects</h1></main>}",
            "app/problem/page.jsx":
              "export default function Problem(){return <main><h1>Fixture error state</h1></main>}",
            "proxy.js":
              "export function proxy(request){if(request.nextUrl.pathname==='/problem')return new Response('<html><body><h1>Fixture error state</h1></body></html>',{status:500,headers:{'content-type':'text/html'}})} export const config={matcher:'/problem'}",
          };
          for (const [path, text] of Object.entries(files)) {
            await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
            await NodeFSP.writeFile(NodePath.join(root, path), text);
          }
          const child = NodeChildProcess.fork(
            NodeURL.fileURLToPath(new URL("./fixtures/atlas-next-server.mjs", import.meta.url)),
            [root],
            { stdio: ["ignore", "pipe", "pipe", "ipc"] },
          );
          let log = "";
          child.stdout?.on("data", (chunk: Buffer) => {
            log = (log + chunk.toString()).slice(-4000);
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            log = (log + chunk.toString()).slice(-4000);
          });
          closeApp = async () => {
            if (child.exitCode !== null) return;
            child.send({ type: "stop" });
            try {
              await NodeEvents.default.once(child, "exit", { signal: AbortSignal.timeout(10000) });
            } catch {
              child.kill();
            }
          };
          return new Promise<string>((accept, reject) => {
            child.once("error", reject);
            child.once("exit", () =>
              reject(new Error(`Next fixture exited before readiness: ${log}`)),
            );
            child.on("message", (message: unknown) => {
              if (
                message &&
                typeof message === "object" &&
                "origin" in message &&
                typeof message.origin === "string"
              )
                accept(message.origin);
            });
          });
        });
        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("runtime-project"),
          projectId,
          title: "Runtime fixture",
          workspaceRoot: harness.workspaceDir,
          createdAt: "2026-10-27T00:00:00.000Z",
        });
        yield* harness.codebase.atlas({
          projectId,
          action: {
            type: "index",
            commandId: CommandId.make("runtime-index"),
            expectedRevision: null,
          },
        });
        yield* harness.codebase.drain;
        yield* harness.codebase.atlas({
          projectId,
          action: { type: "browser-setup", commandId: CommandId.make("runtime-browser-setup") },
        });
        yield* harness.codebase.drain;
        yield* harness.codebase.atlas({
          projectId,
          action: { type: "attach", origin, prefix: "" },
        });
        const state = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
          cookies: [
            {
              name: "atlas-member",
              value: "yes",
              domain: "127.0.0.1",
              path: "/",
              expires: -1,
              httpOnly: true,
              secure: false,
              sameSite: "Lax",
            },
          ],
          origins: [],
        });
        yield* harness.codebase.atlas({
          projectId,
          action: { type: "session", id: "member", name: "Fixture member", storageState: state },
        });
        const indexed = yield* harness.codebase.atlas({ projectId, action: { type: "read" } });
        expect(indexed.browserAvailable).toBe(true);
        const route = indexed.nodes.find((n) => n.pattern === "/projects/[id]")!;
        const problem = indexed.nodes.find((n) => n.pattern === "/problem")!;
        const base: AtlasScenario = {
          id: "populated",
          routeId: route.id,
          name: "Populated member",
          parameters: { id: "42" },
          query: {},
          viewport: "desktop",
          theme: "dark",
          readiness: { kind: "text", value: "Project 42" },
          sessionId: "member",
        };
        const scenarios: AtlasScenario[] = [
          base,
          {
            ...base,
            id: "empty",
            name: "Empty member",
            query: { view: "empty" },
            readiness: { kind: "text", value: "No projects yet" },
          },
          {
            id: "signed_out",
            routeId: route.id,
            name: "Signed out",
            parameters: { id: "42" },
            query: {},
            viewport: "mobile",
            theme: "light",
            readiness: { kind: "text", value: "Sign in to projects" },
            expectedPath: "/login",
          },
          {
            ...base,
            id: "error",
            routeId: problem.id,
            name: "Error screen",
            parameters: {},
            expectedStatus: 500,
            readiness: { kind: "text", value: "Fixture error state" },
          },
        ];
        yield* harness.codebase.atlas({
          projectId,
          action: {
            type: "documentation",
            expectedRevision: null,
            documentation: { version: 1, features: [], scenarios },
          },
        });
        yield* harness.codebase.atlas({
          projectId,
          action: {
            type: "capture",
            commandId: CommandId.make("runtime-capture"),
            scenarioIds: scenarios.map((s) => s.id),
          },
        });
        yield* harness.codebase.drain;
        const captured = yield* harness.codebase.atlas({ projectId, action: { type: "read" } });
        expect(captured.captures.map((c) => [c.scenarioId, c.outcome]).sort()).toEqual([
          ["empty", "ready"],
          ["error", "expected-error"],
          ["populated", "ready"],
          ["signed_out", "expected-redirect"],
        ]);
        expect(
          captured.captures.every(
            (c) => c.available && !c.outdated && c.imageUrl?.startsWith("/api/assets/"),
          ),
        ).toBe(true);
        const capture = captured.captures.find((c) => c.scenarioId === "populated")!;
        const parts = capture.imageUrl!.split("/");
        const resolved = yield* resolveAsset(parts[3]!, parts[4]!).pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerSecretStore.layer.pipe(
                Layer.provideMerge(
                  ServerConfig.layerTest(
                    harness.workspaceDir,
                    NodePath.dirname(harness.workspaceDir),
                  ),
                ),
              ),
              WorkspacePaths.layer,
            ),
          ),
        );
        expect(resolved?.kind).toBe("file");
        const bytes = yield* Effect.promise(() => NodeFSP.readFile(resolved!.path));
        expect(bytes.readUInt32BE(16)).toBe(1440);
        expect(bytes.readUInt32BE(20)).toBe(900);
        const evidenceDirectory = process.env.T3_ATLAS_EVIDENCE_DIR;
        if (evidenceDirectory) {
          const evidence = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
            revision: captured.revision,
            results: captured.captures.map((c) => ({
              scenario: c.scenarioId,
              outcome: c.outcome,
              available: c.available,
              outdated: c.outdated,
            })),
            scope:
              "Real Next app, real Chromium, service capture requests and signed environment asset resolution; client UI acceptance is separate.",
          });
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(evidenceDirectory, { recursive: true });
            for (const capture of captured.captures)
              await NodeFSP.copyFile(
                NodePath.join(NodePath.dirname(resolved!.path), `${capture.id}.png`),
                NodePath.join(evidenceDirectory, `${capture.scenarioId}.png`),
              );
            await NodeFSP.writeFile(
              NodePath.join(evidenceDirectory, "runtime-acceptance.json"),
              evidence,
            );
          });
        }
        yield* harness.codebase.atlas({
          projectId,
          action: { type: "delete-capture", captureId: capture.id },
        });
        expect(
          (yield* harness.codebase.atlas({ projectId, action: { type: "read" } })).captures.find(
            (c) => c.id === capture.id,
          )?.available,
        ).toBe(false);
      }).pipe(Effect.ensuring(Effect.promise(() => closeApp())), Effect.ensuring(harness.dispose));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  240000,
);
