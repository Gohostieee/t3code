// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeFS from "node:fs";
// @effect-diagnostics nodeBuiltinImport:off
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  AtlasDocument,
  AtlasJob,
  AtlasTarget,
  AtlasCapture,
  CodebaseError,
  type CodebaseAtlasInput,
  type CodebaseAtlasSnapshot,
  type CodebaseCheckoutInput,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { CodebaseArtifactStore, type CodebaseBinding } from "./CodebaseArtifactStore.ts";
import {
  ATLAS_EXTRACTOR_VERSION,
  atlasHash,
  atlasId,
  discoverAtlasApps,
  makeAtlasExtractor,
} from "./AtlasExtractor.ts";
import {
  readAtlas,
  readAtlasDocumentation,
  writeAtlas,
  writeAtlasDocumentation,
} from "./AtlasStorage.ts";
import { withCheckoutLock } from "../vcs/CheckoutLock.ts";
import { ServerConfig } from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { issueAtlasCaptureUrl } from "../assets/AssetAccess.ts";
import {
  makeAtlasCaptureRunner,
  atlasBrowserAvailable,
  atlasCaptureFile,
  AtlasSessionState,
  pruneAtlasCaptures,
  atlasScenarioUrl,
} from "./AtlasCaptureRunner.ts";

const asError = (cause: unknown) =>
  Schema.is(CodebaseError)(cause)
    ? cause
    : new CodebaseError({ code: "io", message: String(cause) });
const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: asError });
const active = (job: AtlasJob) =>
  [
    "queued",
    "inventorying",
    "parsing",
    "resolving",
    "validating",
    "publishing",
    "capturing",
  ].includes(job.status);
const jobSchema = Schema.fromJsonString(AtlasJob);
const json = Schema.encodeSync(Schema.UnknownFromJsonString);
const now = Effect.map(DateTime.now, DateTime.formatIso);
const Work = Schema.Struct({
  expectedRevision: Schema.NullOr(Schema.String),
  documentationRevision: Schema.optional(Schema.NullOr(Schema.String)),
  sourceFingerprint: Schema.optional(Schema.String),
  gitHead: Schema.optional(Schema.String),
  gitBranch: Schema.optional(Schema.NullOr(Schema.String)),
  targetRevision: Schema.optional(Schema.String),
  scenarioIds: Schema.optional(Schema.Array(Schema.String)),
});
const Session = Schema.Struct({ id: Schema.String, name: Schema.String, state: AtlasSessionState });
type Resolve = (input: CodebaseCheckoutInput) => Effect.Effect<string, CodebaseError>;

export const makeCodebaseAtlas = Effect.fn("CodebaseAtlas.make")(function* (
  resolve: Resolve,
  changes: PubSub.PubSub<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* CodebaseArtifactStore;
  const config = yield* ServerConfig;
  const secretStore = yield* ServerSecretStore.make;
  const captureRunner = makeAtlasCaptureRunner();
  const extractor = makeAtlasExtractor();
  yield* Effect.addFinalizer(() => io(() => extractor.close()).pipe(Effect.ignore));
  const controllers = new Map<string, AbortController>();
  const commands = yield* Semaphore.make(1);
  const bindings = new Map<string, CodebaseBinding>();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const controller of controllers.values()) controller.abort();
    }).pipe(Effect.andThen(io(() => captureRunner.close()).pipe(Effect.ignore))),
  );
  const readJobs = Effect.fn("CodebaseAtlas.jobs")(function* (checkout: string, root?: string) {
    const rows = yield* (
      root === undefined
        ? sql<{
            state_json: string;
          }>`SELECT state_json FROM codebase_atlas_jobs WHERE checkout = ${checkout} AND json_extract(state_json, '$.attachedTo') IS NULL ORDER BY rowid DESC LIMIT 50`
        : sql<{
            state_json: string;
          }>`SELECT state_json FROM codebase_atlas_jobs WHERE checkout = ${checkout} AND app_root = ${root} AND json_extract(state_json, '$.attachedTo') IS NULL ORDER BY rowid DESC LIMIT 50`
    ).pipe(Effect.mapError(asError));
    return yield* Effect.forEach(rows, (r) =>
      Schema.decodeUnknownEffect(jobSchema)(r.state_json).pipe(Effect.mapError(asError)),
    );
  });
  const saveJob = Effect.fn("CodebaseAtlas.saveJob")(function* (checkout: string, job: AtlasJob) {
    yield* sql`UPDATE codebase_atlas_jobs SET state_json = ${json(job)} WHERE id = ${job.id}`.pipe(
      Effect.mapError(asError),
    );
    yield* PubSub.publish(changes, checkout);
  });
  const prepare = (checkout: string) =>
    store.prepare({ checkout, scopeId: "overview", parentScopeId: null, sourceOnly: true }).pipe(
      Effect.tap((binding) =>
        Effect.sync(() => {
          bindings.delete(checkout);
          bindings.set(checkout, binding);
          if (bindings.size > 2) bindings.delete(bindings.keys().next().value!);
        }),
      ),
    );
  const local = Effect.fn("CodebaseAtlas.local")(function* <A>(
    checkout: string,
    root: string,
    key: string,
    schema: Schema.Codec<A, unknown>,
  ) {
    const rows = yield* sql<{
      value_json: string;
    }>`SELECT value_json FROM codebase_atlas_local WHERE checkout = ${checkout} AND app_root = ${root} AND key = ${key}`.pipe(
      Effect.mapError(asError),
    );
    return rows[0]
      ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(rows[0].value_json).pipe(
          Effect.mapError(asError),
        )
      : null;
  });
  const saveLocal = Effect.fn("CodebaseAtlas.saveLocal")(function* (
    checkout: string,
    root: string,
    key: string,
    value: unknown,
  ) {
    yield* sql`INSERT INTO codebase_atlas_local(checkout, app_root, key, value_json) VALUES (${checkout}, ${root}, ${key}, ${json(value)}) ON CONFLICT(checkout, app_root, key) DO UPDATE SET value_json = excluded.value_json`.pipe(
      Effect.mapError(asError),
    );
    yield* PubSub.publish(changes, checkout);
  });
  const captures = Effect.fn("CodebaseAtlas.captures")(function* (checkout: string, root: string) {
    const rows = yield* sql<{
      value_json: string;
    }>`SELECT value_json FROM codebase_atlas_local WHERE checkout = ${checkout} AND app_root = ${root} AND key LIKE 'capture:%' ORDER BY rowid DESC LIMIT 100`.pipe(
      Effect.mapError(asError),
    );
    return yield* Effect.forEach(rows, (r) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(AtlasCapture))(r.value_json).pipe(
        Effect.mapError(asError),
      ),
    );
  });
  const worker = yield* makeDrainableWorker((id: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        checkout: string;
        app_root: string;
        input_json: string;
        state_json: string;
      }>`SELECT checkout, app_root, input_json, state_json FROM codebase_atlas_jobs WHERE id = ${id}`;
      const row = rows[0];
      if (!row) return;
      let job = yield* Schema.decodeUnknownEffect(jobSchema)(row.state_json);
      if (!active(job)) return;
      const controller = new AbortController();
      controllers.set(id, controller);
      const phase = (status: AtlasJob["status"], label = job.label) =>
        Effect.gen(function* () {
          if (controller.signal.aborted) return;
          job = { ...job, status, label, updatedAt: yield* now };
          yield* saveJob(row.checkout, job);
        });
      yield* Effect.gen(function* () {
        const input = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Work))(
          row.input_json,
        );
        if (job.kind === "browser-setup") {
          yield* phase("capturing", "Setting up the capture browser");
          yield* io(
            () =>
              new Promise<void>((accept, reject) => {
                const child = NodeChildProcess.spawn(
                  process.execPath,
                  [
                    NodePath.join(
                      NodePath.dirname(
                        NodeURL.fileURLToPath(import.meta.resolve("playwright-core")),
                      ),
                      "cli.js",
                    ),
                    "install",
                    "chromium",
                  ],
                  { windowsHide: true, stdio: "ignore", signal: controller.signal },
                );
                child.once("error", reject);
                child.once("exit", (code) =>
                  code === 0
                    ? accept()
                    : reject(new Error("Browser setup failed. See the capture setup runbook.")),
                );
              }),
          );
          if (!controller.signal.aborted)
            yield* saveJob(row.checkout, { ...job, status: "completed", updatedAt: yield* now });
          return;
        }
        if (job.kind === "capture") {
          const target = yield* local(row.checkout, row.app_root, "target", AtlasTarget);
          const accepted = yield* io(() => readAtlas(row.checkout, row.app_root));
          const docs = yield* io(() => readAtlasDocumentation(row.checkout, row.app_root));
          const privateValues = yield* local(
            row.checkout,
            row.app_root,
            "private-values",
            Schema.Record(Schema.String, Schema.String),
          );
          const binding = yield* prepare(row.checkout);
          if (
            !target ||
            target.revision !== input.targetRevision ||
            docs.revision !== input.documentationRevision ||
            accepted?.revision !== input.expectedRevision ||
            binding.sourceFingerprint !== input.sourceFingerprint ||
            binding.gitHead !== input.gitHead ||
            binding.gitBranch !== input.gitBranch
          )
            return yield* new CodebaseError({
              code: "conflict",
              message: "Source, scenario, or target changed before capture.",
            });
          for (const scenarioId of input.scenarioIds ?? []) {
            if (controller.signal.aborted) return;
            const scenario = docs.documentation.scenarios.find((s) => s.id === scenarioId);
            const route = accepted.document.nodes.find(
              (n) => n.id === scenario?.routeId && n.kind === "route",
            );
            if (!scenario || !route)
              return yield* new CodebaseError({
                code: "invalid",
                message: "Repair the scenario's missing route before capture.",
              });
            const session = scenario.sessionId
              ? yield* local(row.checkout, row.app_root, `session:${scenario.sessionId}`, Session)
              : null;
            if (scenario.sessionId && !session)
              return yield* new CodebaseError({
                code: "invalid",
                message: "Import the scenario's private session profile before capture.",
              });
            yield* phase("capturing", scenario.name);
            const id = atlasId();
            const result = yield* io(async () => {
              try {
                return await captureRunner.capture({
                  id,
                  stateDir: config.stateDir,
                  target,
                  route,
                  scenario,
                  ...(session ? { session: session.state } : {}),
                  ...(privateValues ? { privateValues } : {}),
                  signal: controller.signal,
                });
              } catch {
                return {
                  outcome: "unreachable" as const,
                  detail:
                    "The attached application could not be captured. Check its target, readiness condition, and browser setup.",
                  available: false,
                };
              }
            });
            const current = yield* prepare(row.checkout);
            const currentDocs = yield* io(() => readAtlasDocumentation(row.checkout, row.app_root));
            const currentTarget = yield* local(row.checkout, row.app_root, "target", AtlasTarget);
            const changed =
              current.sourceFingerprint !== input.sourceFingerprint ||
              current.gitHead !== input.gitHead ||
              current.gitBranch !== input.gitBranch ||
              currentDocs.revision !== input.documentationRevision ||
              currentTarget?.revision !== target.revision;
            if (controller.signal.aborted) {
              yield* io(() =>
                Promise.all([
                  NodeFSP.unlink(atlasCaptureFile(config.stateDir, id)).catch(() => undefined),
                  NodeFSP.unlink(atlasCaptureFile(config.stateDir, id, true)).catch(
                    () => undefined,
                  ),
                ]),
              );
              return;
            }
            const capture: AtlasCapture = {
              id,
              scenarioId,
              revision: accepted.revision,
              scenarioRevision: atlasHash(json(scenario)),
              targetRevision: target.revision,
              createdAt: yield* now,
              outcome: changed ? "input-changed" : result.outcome,
              detail: changed
                ? "Source, scenario, or target changed during capture."
                : result.detail,
              available: result.available,
              outdated: changed,
            };
            yield* saveLocal(row.checkout, row.app_root, `capture:${id}`, capture);
            yield* io(() => pruneAtlasCaptures(config.stateDir));
            if (changed)
              return yield* new CodebaseError({ code: "conflict", message: capture.detail });
          }
          yield* saveJob(row.checkout, { ...job, status: "completed", updatedAt: yield* now });
          return;
        }
        yield* phase("inventorying");
        const cachedBinding = bindings.get(row.checkout);
        const binding =
          cachedBinding && cachedBinding.sourceFingerprint === input.sourceFingerprint
            ? cachedBinding
            : yield* prepare(row.checkout);
        if (
          binding.sourceFingerprint !== input.sourceFingerprint ||
          binding.gitHead !== input.gitHead ||
          binding.gitBranch !== input.gitBranch
        )
          return yield* new CodebaseError({
            code: "conflict",
            message: "Source changed while this index job was queued. Retry explicitly.",
          });
        const apps = yield* io(() => discoverAtlasApps(row.checkout, binding.inventory));
        const app = apps.find((a) => a.root === row.app_root);
        if (!app)
          return yield* new CodebaseError({
            code: "unavailable",
            message: "The selected application no longer exists.",
          });
        let lastPhase = "";
        const previous = yield* io(() => readAtlas(row.checkout, row.app_root));
        const reusable =
          previous?.document.sourceFingerprint === binding.sourceFingerprint &&
          previous.document.extractor === ATLAS_EXTRACTOR_VERSION;
        const document =
          reusable && previous
            ? previous.document
            : yield* io(() =>
                extractor.extract(
                  binding,
                  app,
                  async (status, path) => {
                    if (status !== lastPhase) {
                      lastPhase = status;
                      await Effect.runPromise(
                        phase(status === "resolving" ? "resolving" : "parsing", path),
                      );
                    }
                  },
                  controller.signal,
                ),
              );
        yield* phase("validating");
        yield* Schema.decodeUnknownEffect(AtlasDocument)(document);
        const ids = new Set(document.nodes.map((node) => node.id));
        const sources = [
          ...document.nodes.map((node) => node.source),
          ...document.edges.map((edge) => edge.source),
        ];
        const inventory = new Map(binding.inventory.map((file) => [file.path, file]));
        if (
          ids.size !== document.nodes.length ||
          document.edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to)) ||
          sources.some((source) => {
            const file = inventory.get(source.path);
            return (
              !file ||
              file.fingerprint !== source.fingerprint ||
              source.startLine < 1 ||
              source.endLine < source.startLine ||
              source.endLine > file.lines
            );
          })
        )
          return yield* new CodebaseError({
            code: "invalid",
            message:
              "The extracted atlas contains duplicate identities, dangling edges, or invalid source evidence.",
          });
        if (controller.signal.aborted) return;
        job = {
          ...job,
          revision: atlasHash(json(document) + "\n"),
          ...(reusable ? { detail: "Source unchanged; reused accepted structural facts." } : {}),
        };
        yield* phase("publishing");
        const revision = yield* withCheckoutLock(
          binding.gitDirectory,
          Effect.gen(function* () {
            const previous = yield* io(() => readAtlas(row.checkout, row.app_root));
            if ((previous?.revision ?? null) !== input.expectedRevision)
              return yield* new CodebaseError({
                code: "conflict",
                message: "Source or accepted atlas changed during indexing. Retry explicitly.",
              });
            if (controller.signal.aborted) return null;
            return yield* io(() =>
              writeAtlas(row.checkout, row.app_root, document, async () => {
                const latest = await Effect.runPromise(prepare(row.checkout));
                if (
                  controller.signal.aborted ||
                  latest.sourceFingerprint !== binding.sourceFingerprint ||
                  latest.gitHead !== binding.gitHead ||
                  latest.gitBranch !== binding.gitBranch
                )
                  throw new CodebaseError({
                    code: "conflict",
                    message: "Source changed before atlas acceptance.",
                  });
                const destination = await readAtlas(row.checkout, row.app_root);
                if ((destination?.revision ?? null) !== input.expectedRevision)
                  throw new CodebaseError({
                    code: "conflict",
                    message:
                      "The accepted atlas changed before publication. Existing content was preserved.",
                  });
              }),
            );
          }),
        ).pipe(Effect.mapError(asError));
        if (!controller.signal.aborted && revision)
          yield* saveJob(row.checkout, {
            ...job,
            status: document.coverage.partial ? "partial" : "completed",
            revision,
            updatedAt: yield* now,
          });
      }).pipe(
        Effect.catch((cause) =>
          controller.signal.aborted
            ? Effect.void
            : Effect.gen(function* () {
                yield* saveJob(row.checkout, {
                  ...job,
                  status:
                    Schema.is(CodebaseError)(cause) && cause.code === "conflict"
                      ? "input-changed"
                      : "failed",
                  detail: asError(cause).message.slice(0, 2048),
                  updatedAt: yield* now,
                });
              }),
        ),
        Effect.ensuring(
          Effect.all([
            io(() => captureRunner.close()).pipe(Effect.ignore),
            Effect.sync(() => controllers.delete(id)),
          ]).pipe(Effect.asVoid),
        ),
      );
    }).pipe(Effect.catch(Effect.logWarning)),
  );
  const token = Effect.fn("CodebaseAtlas.token")(function* (checkout: string) {
    const metadata = yield* sql<{
      value_json: string;
    }>`SELECT value_json FROM codebase_atlas_local WHERE checkout = ${checkout} AND key NOT LIKE 'session:%' ORDER BY app_root, key`.pipe(
      Effect.mapError(asError),
    );
    return atlasHash(
      (yield* readJobs(checkout)).map((j) => `${j.id}:${j.status}:${j.revision ?? ""}`).join("|") +
        metadata.map((r) => r.value_json).join("|"),
    );
  });
  const execute = Effect.fn("CodebaseAtlas.execute")(function* (
    input: CodebaseAtlasInput,
  ): Effect.fn.Return<CodebaseAtlasSnapshot, CodebaseError> {
    const checkout = yield* resolve(input);
    let requestedRoot = input.appRoot;
    if (input.action.type === "cancel") {
      const cancellation = input.action;
      const rows = yield* sql<{
        app_root: string;
      }>`SELECT app_root FROM codebase_atlas_jobs WHERE checkout = ${checkout} AND id = ${cancellation.jobId}`.pipe(
        Effect.mapError(asError),
      );
      if (!rows[0] || (requestedRoot !== undefined && requestedRoot !== rows[0].app_root))
        return yield* new CodebaseError({
          code: "unavailable",
          message: "Job is not available in this application.",
        });
      requestedRoot ??= rows[0].app_root;
      const job = (yield* readJobs(checkout)).find((entry) => entry.id === cancellation.jobId);
      if (!job)
        return yield* new CodebaseError({
          code: "unavailable",
          message: "Job is not available in this checkout.",
        });
      controllers.get(job.id)?.abort();
      if (active(job))
        yield* saveJob(checkout, { ...job, status: "cancelled", updatedAt: yield* now });
    }
    const cached =
      input.action.type === "read" && input.verifyFreshness === false
        ? bindings.get(checkout)
        : undefined;
    const binding = cached ?? (yield* prepare(checkout));
    const apps = yield* io(() => discoverAtlasApps(checkout, binding.inventory));
    const appRoot = requestedRoot ?? apps.find((a) => a.supported)?.root ?? apps[0]!.root;
    if (!apps.some((a) => a.root === appRoot))
      return yield* new CodebaseError({
        code: "invalid",
        message: "Select an inventoried application root.",
      });
    const action = input.action;
    if (action.type === "index" || action.type === "capture" || action.type === "browser-setup") {
      const { commandId: _, ...payload } = action;
      const fingerprint = atlasHash(json(payload));
      const previous = yield* sql<{
        id: string;
        input_hash: string;
      }>`SELECT id, input_hash FROM codebase_atlas_jobs WHERE checkout = ${checkout} AND app_root = ${appRoot} AND command_id = ${action.commandId}`.pipe(
        Effect.mapError(asError),
      );
      if (previous[0] && previous[0].input_hash !== fingerprint)
        return yield* new CodebaseError({
          code: "conflict",
          message: "This command ID was already used with different input.",
        });
      if (!previous.length) {
        const jobs = yield* readJobs(checkout);
        if (jobs.filter(active).length >= 20)
          return yield* new CodebaseError({ code: "busy", message: "The indexing queue is full." });
        const target = yield* local(checkout, appRoot, "target", AtlasTarget);
        const accepted = yield* io(() => readAtlas(checkout, appRoot));
        const docs = yield* io(() => readAtlasDocumentation(checkout, appRoot));
        if (action.type === "capture" && (!target || !accepted))
          return yield* new CodebaseError({
            code: "invalid",
            message: "Index the app and attach a running target before capturing.",
          });
        if (action.type === "capture" && target && accepted) {
          const values = yield* local(
            checkout,
            appRoot,
            "private-values",
            Schema.Record(Schema.String, Schema.String),
          );
          for (const id of action.scenarioIds) {
            const scenario = docs.documentation.scenarios.find((entry) => entry.id === id);
            const route = accepted.document.nodes.find(
              (entry) => entry.kind === "route" && entry.id === scenario?.routeId,
            );
            if (!scenario || !route)
              return yield* new CodebaseError({
                code: "invalid",
                message: "Repair the scenario's missing route before capture.",
              });
            if (!scenario.readiness.value.trim())
              return yield* new CodebaseError({
                code: "invalid",
                message: "Configure visible text or a locator before capturing this scenario.",
              });
            yield* Effect.try({
              try: () => atlasScenarioUrl(target, route, scenario, values ?? {}),
              catch: (cause) =>
                new CodebaseError({
                  code: "invalid",
                  message:
                    cause instanceof Error
                      ? cause.message
                      : "The scenario needs valid route parameters.",
                }),
            });
            if (
              scenario.sessionId &&
              !(yield* local(checkout, appRoot, `session:${scenario.sessionId}`, Session))
            )
              return yield* new CodebaseError({
                code: "invalid",
                message: "Import or select the scenario's private session profile before capture.",
              });
          }
        }
        let job: AtlasJob = {
          id: `job_${atlasId()}`,
          kind: action.type,
          status: "queued",
          label: appRoot,
          detail: null,
          revision: null,
          updatedAt: yield* now,
        };
        const work = {
          expectedRevision:
            action.type === "index" ? action.expectedRevision : (accepted?.revision ?? null),
          sourceFingerprint: binding.sourceFingerprint,
          gitHead: binding.gitHead,
          gitBranch: binding.gitBranch,
          documentationRevision: docs.revision,
          ...(target ? { targetRevision: target.revision } : {}),
          ...(action.type === "capture" ? { scenarioIds: action.scenarioIds } : {}),
        };
        if (action.type === "index") {
          const candidates = yield* sql<{
            id: string;
            input_json: string;
            state_json: string;
          }>`SELECT id, input_json, state_json FROM codebase_atlas_jobs WHERE checkout = ${checkout} AND app_root = ${appRoot} AND input_hash = ${fingerprint} AND json_extract(state_json, '$.attachedTo') IS NULL ORDER BY rowid DESC LIMIT 1`.pipe(
            Effect.mapError(asError),
          );
          const candidate = candidates[0];
          if (candidate) {
            const existing = yield* Schema.decodeUnknownEffect(jobSchema)(
              candidate.state_json,
            ).pipe(Effect.mapError(asError));
            const prior = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Work))(
              candidate.input_json,
            ).pipe(Effect.mapError(asError));
            if (
              active(existing) &&
              prior.sourceFingerprint === binding.sourceFingerprint &&
              prior.gitHead === binding.gitHead &&
              prior.gitBranch === binding.gitBranch
            )
              job = { ...job, attachedTo: existing.id };
          }
        }
        yield* sql`INSERT INTO codebase_atlas_jobs (id, checkout, app_root, command_id, input_hash, input_json, state_json) VALUES (${job.id}, ${checkout}, ${appRoot}, ${action.commandId}, ${fingerprint}, ${json(work)}, ${json(job)})`.pipe(
          Effect.mapError(asError),
        );
        yield* PubSub.publish(changes, checkout);
        if (!job.attachedTo) yield* worker.enqueue(job.id);
      }
    } else if (action.type === "cancel") {
      const job = (yield* readJobs(checkout, appRoot)).find((j) => j.id === action.jobId);
      if (!job)
        return yield* new CodebaseError({
          code: "unavailable",
          message: "Job is no longer available in this checkout.",
        });
      controllers.get(job.id)?.abort();
      if (active(job))
        yield* saveJob(checkout, { ...job, status: "cancelled", updatedAt: yield* now });
    } else if (action.type === "attach") {
      if (action.origin === null)
        yield* sql`DELETE FROM codebase_atlas_local WHERE checkout = ${checkout} AND app_root = ${appRoot} AND key = 'target'`.pipe(
          Effect.mapError(asError),
        );
      else {
        const target = yield* Effect.try({
          try: () => new URL(action.origin!),
          catch: () =>
            new CodebaseError({
              code: "invalid",
              message: "Supply an HTTP(S) origin reachable from this environment.",
            }),
        });
        if (
          !["http:", "https:"].includes(target.protocol) ||
          target.username ||
          target.password ||
          !/^\/?[^?#\\]*$/.test(action.prefix) ||
          action.prefix.startsWith("//")
        )
          return yield* new CodebaseError({
            code: "invalid",
            message: "Use an HTTP(S) origin without credentials and a relative deployment prefix.",
          });
        yield* saveLocal(checkout, appRoot, "target", {
          origin: target.origin,
          prefix: action.prefix ? `/${action.prefix.replace(/^\/+|\/+$/g, "")}` : "",
          revision: atlasId(),
          provenance: "user-confirmed; running source unverified",
        });
      }
      yield* PubSub.publish(changes, checkout);
    } else if (action.type === "private-value") {
      const previous = yield* local(
        checkout,
        appRoot,
        "private-values",
        Schema.Record(Schema.String, Schema.String),
      );
      const values = { ...previous };
      if (action.value === null) delete values[action.name];
      else values[action.name] = action.value;
      if (Object.keys(values).length > 50)
        return yield* new CodebaseError({
          code: "invalid",
          message: "At most 50 private substitutions can be stored per application.",
        });
      yield* saveLocal(checkout, appRoot, "private-values", values);
      const target = yield* local(checkout, appRoot, "target", AtlasTarget);
      if (target) yield* saveLocal(checkout, appRoot, "target", { ...target, revision: atlasId() });
    } else if (action.type === "session") {
      if (action.storageState === null)
        yield* sql`DELETE FROM codebase_atlas_local WHERE checkout = ${checkout} AND app_root = ${appRoot} AND key = ${`session:${action.id}`}`.pipe(
          Effect.mapError(asError),
        );
      else {
        const existing = yield* local(checkout, appRoot, `session:${action.id}`, Session);
        if (!existing) {
          const count = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM codebase_atlas_local WHERE checkout = ${checkout} AND app_root = ${appRoot} AND key LIKE 'session:%'`.pipe(
            Effect.mapError(asError),
          );
          if ((count[0]?.count ?? 0) >= 50)
            return yield* new CodebaseError({
              code: "invalid",
              message:
                "At most 50 private session profiles can be stored per application. Remove or replace a profile first.",
            });
        }
        const state = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AtlasSessionState))(
          action.storageState,
        ).pipe(
          Effect.mapError(
            () =>
              new CodebaseError({
                code: "invalid",
                message: "The session profile must be valid Playwright storage state.",
              }),
          ),
        );
        yield* saveLocal(checkout, appRoot, `session:${action.id}`, {
          id: action.id,
          name: action.name,
          state,
        });
      }
      const target = yield* local(checkout, appRoot, "target", AtlasTarget);
      if (target) yield* saveLocal(checkout, appRoot, "target", { ...target, revision: atlasId() });
    } else if (action.type === "delete-capture") {
      const capture = yield* local(checkout, appRoot, `capture:${action.captureId}`, AtlasCapture);
      if (capture) {
        yield* io(() =>
          Promise.all([
            NodeFSP.unlink(atlasCaptureFile(config.stateDir, capture.id)).catch(() => undefined),
            NodeFSP.unlink(atlasCaptureFile(config.stateDir, capture.id, true)).catch(
              () => undefined,
            ),
          ]),
        );
        yield* saveLocal(checkout, appRoot, `capture:${capture.id}`, {
          ...capture,
          available: false,
        });
      }
    } else if (action.type === "documentation") {
      const ids = [...action.documentation.features, ...action.documentation.scenarios].map(
        (v) => v.id,
      );
      if (new Set(ids).size !== ids.length)
        return yield* new CodebaseError({
          code: "invalid",
          message: "Documentation IDs must be unique.",
        });
      yield* withCheckoutLock(
        binding.gitDirectory,
        io(async () => {
          const previous = await readAtlasDocumentation(checkout, appRoot);
          if (previous.revision !== action.expectedRevision)
            throw new CodebaseError({
              code: "conflict",
              message: "Documentation changed on another client. Reload before saving.",
            });
          await writeAtlasDocumentation(checkout, appRoot, action.documentation);
        }),
      ).pipe(Effect.mapError(asError));
      yield* PubSub.publish(changes, checkout);
    }
    if (action.type !== "read") yield* saveLocal(checkout, appRoot, "revision", atlasId());
    const result = yield* Effect.result(io(() => readAtlas(checkout, appRoot, !!cached)));
    const accepted = result._tag === "Success" ? result.success : null;
    const detail = result._tag === "Failure" ? result.failure.message : null;
    const documentation = yield* io(() => readAtlasDocumentation(checkout, appRoot));
    const target = yield* local(checkout, appRoot, "target", AtlasTarget);
    const captureList = yield* captures(checkout, appRoot);
    const visibleCaptures = yield* Effect.forEach(captureList, (capture) =>
      Effect.gen(function* () {
        const scenario = documentation.documentation.scenarios.find(
          (s) => s.id === capture.scenarioId,
        );
        const available =
          capture.available && NodeFS.existsSync(atlasCaptureFile(config.stateDir, capture.id));
        const outdated =
          capture.outdated ||
          capture.revision !== accepted?.revision ||
          capture.targetRevision !== target?.revision ||
          capture.scenarioRevision !== atlasHash(json(scenario ?? null)) ||
          accepted?.document.sourceFingerprint !== binding.sourceFingerprint;
        if (!available) return { ...capture, available: false, outdated };
        const imageUrl = yield* issueAtlasCaptureUrl(capture.id, false).pipe(
          Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
          Effect.mapError(asError),
        );
        const thumbnailUrl = yield* issueAtlasCaptureUrl(capture.id, true).pipe(
          Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
          Effect.mapError(asError),
        );
        return { ...capture, available, outdated, imageUrl, thumbnailUrl };
      }),
    );
    const sessionRows = yield* sql<{
      value_json: string;
    }>`SELECT value_json FROM codebase_atlas_local WHERE checkout = ${checkout} AND app_root = ${appRoot} AND key LIKE 'session:%' LIMIT 50`.pipe(
      Effect.mapError(asError),
    );
    const sessions = yield* Effect.forEach(sessionRows, (r) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(Session))(r.value_json).pipe(
        Effect.map((s) => ({ id: s.id, name: s.name })),
        Effect.mapError(asError),
      ),
    );
    const privateValues = yield* local(
      checkout,
      appRoot,
      "private-values",
      Schema.Record(Schema.String, Schema.String),
    );
    const document = accepted?.document;
    const query = input.query?.toLowerCase() ?? "";
    const grouped = new Set(
      documentation.documentation.features.flatMap((feature) => feature.members),
    );
    let filtered = (document?.nodes ?? []).filter(
      (n) =>
        (!input.ungrouped || (n.kind === "route" && !grouped.has(n.id))) &&
        (!query || `${n.label} ${n.source.path}`.toLowerCase().includes(query)) &&
        (input.view === "routes"
          ? ["route", "endpoint"].includes(n.kind)
          : input.view === "modules"
            ? n.kind === "module"
            : true),
    );
    if (input.nodeId) {
      const related = new Set([input.nodeId]);
      for (const e of document?.edges ?? [])
        if (e.from === input.nodeId || e.to === input.nodeId) {
          related.add(e.from);
          related.add(e.to);
        }
      filtered = (document?.nodes ?? []).filter((n) => related.has(n.id));
    }
    const offset = input.offset ?? 0;
    const nodes = filtered.slice(offset, offset + 80);
    const selected = new Set(nodes.map((n) => n.id));
    const scopeIds = new Set(filtered.map((node) => node.id));
    const scopedEdges = (document?.edges ?? []).filter(
      (edge) => scopeIds.has(edge.from) && scopeIds.has(edge.to),
    );
    const visibleEdges = scopedEdges
      .filter((edge) => selected.has(edge.from) && selected.has(edge.to))
      .slice(0, 200);
    const files = (document?.files ?? []).filter((f) => f.path.toLowerCase().includes(query));
    const factIds = new Set(document?.nodes.map((n) => n.id) ?? []);
    const missing = [
      ...documentation.documentation.features.flatMap((f) =>
        f.members
          .filter((id) => !factIds.has(id))
          .map((id) => ({
            path: f.name,
            code: "missing-reference",
            message: `Feature member ${id} no longer exists. Remove or reassign it explicitly.`,
          })),
      ),
      ...documentation.documentation.scenarios
        .filter((s) => !factIds.has(s.routeId))
        .map((s) => ({
          path: s.name,
          code: "missing-reference",
          message: "The scenario's route no longer exists. Reassign or remove the scenario.",
        })),
    ];
    const diagnostics = [...(document?.diagnostics ?? []), ...missing].filter((f) =>
      `${f.path} ${f.message}`.toLowerCase().includes(query),
    );
    return {
      checkout,
      branch: binding.gitBranch,
      appRoot,
      apps,
      state: detail ? "invalid" : accepted ? "ready" : "unbuilt",
      revision: accepted?.revision ?? null,
      freshness: cached
        ? "unknown"
        : document
          ? document.sourceFingerprint === binding.sourceFingerprint &&
            document.extractor === ATLAS_EXTRACTOR_VERSION
            ? "current"
            : "stale"
          : "unknown",
      nodes,
      edges: visibleEdges,
      totalEdges: scopedEdges.length,
      viewPartial: filtered.length > nodes.length || scopedEdges.length > visibleEdges.length,
      files: files.slice(offset, offset + 50),
      diagnostics: diagnostics.slice(offset, offset + 50),
      total:
        input.view === "files"
          ? files.length
          : input.view === "diagnostics"
            ? diagnostics.length
            : filtered.length,
      coverage: document?.coverage ?? {
        totalFiles: binding.inventory.length,
        parsedFiles: 0,
        routes: 0,
        endpoints: 0,
        unresolved: 0,
        partial: true,
      },
      documentation: documentation.documentation,
      documentationRevision: documentation.revision,
      jobs: yield* readJobs(checkout, appRoot),
      captures: visibleCaptures,
      target,
      sessions,
      privateValueNames: Object.keys(privateValues ?? {}),
      browserAvailable: atlasBrowserAvailable(),
      detail,
    };
  });
  const start = Effect.fn("CodebaseAtlas.recover")(function* () {
    const rows = yield* sql<{
      checkout: string;
      app_root: string;
      state_json: string;
    }>`SELECT checkout, app_root, state_json FROM codebase_atlas_jobs`.pipe(
      Effect.mapError(asError),
    );
    for (const row of rows) {
      const job = yield* Schema.decodeUnknownEffect(jobSchema)(row.state_json).pipe(
        Effect.mapError(asError),
      );
      if (job.attachedTo) continue;
      if (active(job)) {
        const accepted = yield* Effect.result(io(() => readAtlas(row.checkout, row.app_root)));
        const recovered =
          job.kind === "index" &&
          job.status === "publishing" &&
          accepted._tag === "Success" &&
          accepted.success?.revision === job.revision;
        yield* saveJob(row.checkout, {
          ...job,
          status: recovered ? "completed" : "interrupted",
          detail: recovered
            ? "Recovered an already accepted atlas revision without repeating work."
            : "The environment restarted. Accepted content is preserved; retry explicitly.",
          updatedAt: yield* now,
        });
      }
    }
  });
  return {
    execute: (input: CodebaseAtlasInput) =>
      input.action.type === "read" ? execute(input) : commands.withPermits(1)(execute(input)),
    start,
    drain: worker.drain,
    token,
    jobs: readJobs,
  };
});
