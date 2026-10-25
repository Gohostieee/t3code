import { buildCodebaseInput, isExcludedCodebaseSource } from "./CodebaseInput.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import {
  CodebaseAnalysis,
  CodebaseAnalyzerBindings,
  CodebaseError,
  CodebaseRun,
  CommandId,
  MessageId,
  ModelSelection,
  ThreadId,
  isCodebaseAnalysisActive,
  type CodebaseCancelInput,
  type CodebaseCheckoutInput,
  type CodebaseConfigureInput,
  type CodebaseProgress,
  type CodebaseReadInput,
  type CodebaseSnapshot,
  type CodebaseStartInput,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProjectionTurnState } from "../persistence/Services/ProjectionTurns.ts";
import { VcsProcess } from "../vcs/VcsProcess.ts";
import {
  CodebaseArtifactStore,
  codebaseDocumentRevision,
  type CodebaseBinding,
} from "./CodebaseArtifactStore.ts";

const isCodebaseError = Schema.is(CodebaseError);
const failure = (code: CodebaseError["code"], message: string) =>
  new CodebaseError({ code, message });
const asError = (cause: unknown) => (isCodebaseError(cause) ? cause : failure("io", String(cause)));
const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const sameSelection = (left: ModelSelection, right: ModelSelection) =>
  left.instanceId === right.instanceId &&
  left.model === right.model &&
  JSON.stringify([...(left.options ?? [])].sort((a, b) => a.id.localeCompare(b.id))) ===
    JSON.stringify([...(right.options ?? [])].sort((a, b) => a.id.localeCompare(b.id)));
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const AnalysisTurnRow = Schema.Struct({
  state: ProjectionTurnState,
  assistantMessageId: Schema.NullOr(MessageId),
});
const decodeAnalysisTurns = Schema.decodeUnknownEffect(Schema.Array(AnalysisTurnRow));
const RunRow = Schema.Struct({
  ...CodebaseRun.fields,
  modelSelection: Schema.fromJsonString(ModelSelection),
  analysis: Schema.fromJsonString(CodebaseAnalysis),
});

export class CodebaseService extends Context.Service<
  CodebaseService,
  {
    readonly read: (input: CodebaseReadInput) => Effect.Effect<CodebaseSnapshot, CodebaseError>;
    readonly configure: (
      input: CodebaseConfigureInput,
    ) => Effect.Effect<CodebaseSnapshot, CodebaseError>;
    readonly startAnalysis: (
      input: CodebaseStartInput,
    ) => Effect.Effect<CodebaseRun, CodebaseError>;
    readonly cancel: (input: CodebaseCancelInput) => Effect.Effect<CodebaseRun, CodebaseError>;
    readonly status: (
      input: CodebaseCheckoutInput,
    ) => Effect.Effect<CodebaseProgress, CodebaseError>;
    readonly subscribe: (
      input: CodebaseCheckoutInput,
    ) => Effect.Effect<Stream.Stream<CodebaseProgress, CodebaseError>, CodebaseError, Scope.Scope>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/codebase/CodebaseService") {
  static readonly layer = Layer.effect(
    CodebaseService,
    Effect.gen(function* () {
      const store = yield* CodebaseArtifactStore;
      const engine = yield* OrchestrationEngineService;
      const query = yield* ProjectionSnapshotQuery;
      const provider = yield* ProviderService;
      const registry = yield* ProviderRegistry;
      const vcs = yield* VcsProcess;
      const sql = yield* SqlClient.SqlClient;
      const changes = yield* PubSub.unbounded<string>();
      const mutex = yield* Semaphore.make(1);
      let recovering = true;
      const canonical = (path: string) =>
        Effect.tryPromise({ try: () => NodeFSP.realpath(path), catch: asError });

      const resolve = Effect.fn("CodebaseService.resolve")(function* (
        input: CodebaseCheckoutInput,
      ) {
        const project = yield* query
          .getProjectShellById(input.projectId)
          .pipe(Effect.mapError(asError));
        if (Option.isNone(project))
          return yield* failure("unavailable", "Project is no longer available.");
        if (input.threadId) {
          const thread = yield* query
            .getThreadShellById(input.threadId)
            .pipe(Effect.mapError(asError));
          if (Option.isNone(thread) || thread.value.projectId !== input.projectId)
            return yield* failure("unavailable", "The thread does not belong to this project.");
          return yield* canonical(thread.value.worktreePath ?? project.value.workspaceRoot);
        }
        const main = yield* canonical(project.value.workspaceRoot);
        if (!input.checkout) return main;
        const requested = yield* canonical(input.checkout);
        if (requested === main) return main;
        const runGit = (args: string[]) =>
          vcs
            .run({ operation: "codebase.resolve", command: "git", args, cwd: main })
            .pipe(Effect.mapError(asError));
        const root = (yield* runGit(["rev-parse", "--show-toplevel"])).stdout.trim();
        const relative = NodePath.relative(root, main);
        const worktrees = (yield* runGit(["worktree", "list", "--porcelain", "-z"])).stdout
          .split("\0")
          .filter((part) => part.startsWith("worktree "))
          .map((part) => NodePath.join(part.slice(9), relative));
        for (const worktree of worktrees) {
          const result = yield* Effect.result(canonical(worktree));
          if (result._tag === "Success" && result.success === requested) return requested;
        }
        return yield* failure(
          "unavailable",
          "Select an existing worktree belonging to this project.",
        );
      });

      const runs = Effect.fn("CodebaseService.runs")(function* (checkout?: string) {
        const rows = yield* (
          checkout
            ? sql`
        SELECT thread_id AS "threadId", project_id AS "projectId", model_selection_json AS "modelSelection", analysis_json AS "analysis"
        FROM projection_threads WHERE analysis_json IS NOT NULL AND deleted_at IS NULL
          AND json_extract(analysis_json, '$.checkout') = ${checkout} ORDER BY CASE WHEN json_extract(analysis_json, '$.status') IN ('queued', 'running', 'waiting', 'validating', 'saving') THEN 0 ELSE 1 END, created_at DESC LIMIT 50
      `
            : sql`
        SELECT thread_id AS "threadId", project_id AS "projectId", model_selection_json AS "modelSelection", analysis_json AS "analysis"
        FROM projection_threads WHERE analysis_json IS NOT NULL AND deleted_at IS NULL
          AND json_extract(analysis_json, '$.status') IN ('queued', 'running', 'waiting', 'validating', 'saving')
        ORDER BY created_at ASC
      `
        ).pipe(Effect.mapError(asError));
        return yield* Schema.decodeUnknownEffect(Schema.Array(RunRow))(rows).pipe(
          Effect.mapError(asError),
        );
      });
      const threadById = Effect.fn("CodebaseService.thread")(function* (threadId: ThreadId) {
        const result = yield* query.getThreadDetailById(threadId).pipe(Effect.mapError(asError));
        if (Option.isNone(result) || !result.value.analysis)
          return yield* failure("unavailable", "Analysis attempt is unavailable.");
        return result.value;
      });
      const toRun = (thread: OrchestrationThread): CodebaseRun => ({
        threadId: thread.id,
        projectId: thread.projectId,
        modelSelection: thread.modelSelection,
        analysis: thread.analysis!,
      });
      const update = Effect.fn("CodebaseService.update")(function* (
        thread: OrchestrationThread,
        patch: Partial<CodebaseAnalysis>,
      ) {
        const analysis = { ...thread.analysis!, ...patch, updatedAt: yield* nowIso };
        yield* engine
          .dispatch({
            type: "thread.analysis.set",
            threadId: thread.id,
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            analysis,
          })
          .pipe(Effect.mapError(asError));
        yield* PubSub.publish(changes, analysis.checkout);
        return { ...thread, analysis };
      });
      const failAttempt = (thread: OrchestrationThread, cause: CodebaseError) =>
        update(thread, {
          status: cause.code === "conflict" ? "input-changed" : "failed",
          detail: cause.message,
        }).pipe(Effect.asVoid);

      // Analysis threads contain one turn; checkpoint completion must not gate its final result.
      const analysisTurn = Effect.fn("CodebaseService.analysisTurn")(function* (
        threadId: ThreadId,
      ) {
        const rows = yield* sql`
          SELECT state, assistant_message_id AS "assistantMessageId"
          FROM projection_turns WHERE thread_id = ${threadId}
          ORDER BY requested_at DESC, row_id DESC LIMIT 1
        `.pipe(Effect.mapError(asError));
        return (yield* decodeAnalysisTurns(rows).pipe(Effect.mapError(asError)))[0];
      });

      const processAttempt = Effect.fn("CodebaseService.processAttempt")(function* (
        threadId: ThreadId,
        recoverCompleted = false,
      ) {
        let thread = yield* threadById(threadId);
        const analysis = thread.analysis!;
        if ((recovering && !recoverCompleted) || !isCodebaseAnalysisActive(analysis.status)) return;
        if (recoverCompleted && analysis.status === "queued")
          return yield* failure(
            "unavailable",
            "The server restarted before this analysis began. Retry explicitly.",
          );
        if (analysis.status === "queued") {
          const others = yield* runs(analysis.checkout);
          if (
            others.some(
              (run) =>
                run.threadId !== threadId &&
                isCodebaseAnalysisActive(run.analysis.status) &&
                run.analysis.status !== "queued",
            )
          )
            return;
          const binding = yield* store.prepare({
            checkout: analysis.checkout,
            scopeId: analysis.scopeId,
            parentScopeId: analysis.parentScopeId,
          });
          if (
            binding.sourceFingerprint !== analysis.sourceFingerprint ||
            binding.gitHead !== analysis.gitHead ||
            binding.gitBranch !== analysis.gitBranch ||
            binding.expectedRevision !== analysis.expectedRevision ||
            binding.configurationRevision !== analysis.configurationRevision ||
            binding.parentRevision !== analysis.parentRevision
          ) {
            return yield* failure(
              "conflict",
              "Inputs changed while this analysis was queued. Start a new pass.",
            );
          }
          const prompt = buildCodebaseInput(binding).prompt;
          thread = yield* update(thread, { status: "running" });
          yield* engine
            .dispatch({
              type: "thread.turn.start",
              commandId: CommandId.make(`codebase-start-${thread.id}`),
              threadId,
              message: {
                messageId: MessageId.make(`codebase-input-${thread.id}`),
                role: "user",
                text: prompt,
                attachments: [],
              },
              modelSelection: thread.modelSelection,
              runtimeMode: "approval-required",
              interactionMode: "default",
              createdAt: yield* nowIso,
            })
            .pipe(Effect.mapError(asError));
          return;
        }
        const startFailure = thread.activities.find(
          (activity) => activity.kind === "provider.turn.start.failed",
        );
        if (startFailure) {
          const payload = startFailure.payload;
          const detail =
            typeof payload === "object" &&
            payload !== null &&
            "detail" in payload &&
            typeof payload.detail === "string"
              ? payload.detail.split("\n")[0]!.slice(0, 1000)
              : startFailure.summary;
          return yield* failure("unavailable", detail);
        }
        const turn = yield* analysisTurn(threadId);
        if (turn?.state === "interrupted") {
          yield* update(thread, { status: "cancelled", detail: "Analysis was interrupted." });
          return;
        }
        if (turn?.state === "error" || thread.session?.status === "error")
          return yield* failure(
            "unavailable",
            thread.session?.lastError ?? "The provider could not complete this analysis.",
          );
        if (turn?.state !== "completed") {
          if (recoverCompleted)
            return yield* failure(
              "unavailable",
              "The server restarted before completion. Retry explicitly to start a new analysis.",
            );
          const shell = yield* query.getThreadShellById(threadId).pipe(Effect.mapError(asError));
          const status =
            Option.isSome(shell) &&
            (shell.value.hasPendingApprovals || shell.value.hasPendingUserInput)
              ? "waiting"
              : "running";
          if (status !== analysis.status) yield* update(thread, { status });
          return;
        }
        const output = thread.messages.find((message) => message.id === turn.assistantMessageId);
        if (!output || output.streaming) {
          if (recoverCompleted)
            return yield* failure(
              "unavailable",
              "The completed analysis has no durable final response. Retry explicitly.",
            );
          return;
        }
        thread = yield* update(thread, { status: "validating" });
        const binding = yield* store.prepare({
          checkout: analysis.checkout,
          scopeId: analysis.scopeId,
          parentScopeId: analysis.parentScopeId,
        });
        const original: CodebaseBinding = {
          ...binding,
          expectedRevision: analysis.expectedRevision,
          configurationRevision: analysis.configurationRevision,
          parentRevision: analysis.parentRevision,
          sourceFingerprint: analysis.sourceFingerprint,
          gitHead: analysis.gitHead,
          gitBranch: analysis.gitBranch,
        };
        if (binding.sourceFingerprint !== original.sourceFingerprint)
          return yield* failure("conflict", "Source changed during analysis. Start a new pass.");
        const inputMessage = thread.messages.find(
          (message) => message.id === `codebase-input-${thread.id}`,
        );
        if (inputMessage?.text !== buildCodebaseInput(binding).prompt)
          return yield* failure(
            "conflict",
            "The analysis input bundle changed before acceptance. Retry explicitly with the current input format.",
          );
        const document = yield* store.validate(original, output.text, analysis.analyzer);
        thread = yield* update(thread, {
          status: "saving",
          acceptedRevision: codebaseDocumentRevision(document),
        });
        const acceptedRevision = yield* store.publish(original, document);
        yield* update(thread, { status: "succeeded", acceptedRevision, detail: null });
      });

      const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
        mutex.withPermits(1)(
          processAttempt(threadId).pipe(
            Effect.catch((cause) =>
              threadById(threadId).pipe(
                Effect.flatMap((thread) =>
                  isCodebaseAnalysisActive(thread.analysis!.status)
                    ? failAttempt(thread, cause)
                    : Effect.void,
                ),
                Effect.catch(Effect.logWarning),
              ),
            ),
          ),
        ),
      );

      const validateSelection = Effect.fn("CodebaseService.validateSelection")(function* (
        selection: ModelSelection,
      ) {
        const capabilities = yield* provider
          .getCapabilities(selection.instanceId)
          .pipe(Effect.mapError(asError));
        if (!capabilities.codebaseAnalysis)
          return yield* failure(
            "unsupported",
            "This provider cannot enforce inspection permissions. Choose a supported Codex instance.",
          );
        const catalog = yield* registry.getProviders;
        const instance = catalog.find((entry) => entry.instanceId === selection.instanceId);
        const model = instance?.models.find((entry) => entry.slug === selection.model);
        if (
          !instance?.enabled ||
          !instance.installed ||
          instance.availability === "unavailable" ||
          !model
        )
          return yield* failure(
            "unavailable",
            "The selected provider or model is unavailable. Choose it again in AI setup.",
          );
        for (const option of selection.options ?? []) {
          const descriptor = model.capabilities?.optionDescriptors?.find(
            (entry) => entry.id === option.id,
          );
          if (
            !descriptor ||
            (descriptor.type === "boolean"
              ? typeof option.value !== "boolean"
              : !descriptor.options.some((choice) => choice.id === option.value))
          )
            return yield* failure(
              "unsupported",
              `The model no longer supports option ${option.id}. Update AI setup.`,
            );
        }
        return instance;
      });
      const startAnalysis = Effect.fn("CodebaseService.startAnalysis")(function* (
        input: CodebaseStartInput,
      ) {
        return yield* mutex.withPermits(1)(
          Effect.gen(function* () {
            const checkout = yield* resolve(input);
            const threadId = ThreadId.make(
              `codebase-${hash(`${checkout}:${input.commandId}`).slice(0, 32)}`,
            );
            const existing = yield* query
              .getThreadDetailById(threadId)
              .pipe(Effect.mapError(asError));
            if (Option.isSome(existing)) {
              const previous = existing.value;
              if (
                previous.projectId !== input.projectId ||
                previous.analysis?.scopeId !== input.scopeId ||
                previous.analysis?.parentScopeId !== input.parentScopeId ||
                previous.analysis?.expectedRevision !== input.expectedRevision ||
                !sameSelection(previous.modelSelection, input.modelSelection)
              )
                return yield* failure(
                  "conflict",
                  "This request ID was already used with different analysis inputs.",
                );
              return toRun(previous);
            }
            if (input.scopeId !== "overview" && input.parentScopeId === null)
              return yield* failure(
                "invalid",
                "Open this layer through its parent scope before building it.",
              );
            const binding = yield* store.prepare({
              checkout,
              scopeId: input.scopeId,
              parentScopeId: input.parentScopeId,
            });
            if (binding.expectedRevision !== input.expectedRevision)
              return yield* failure(
                "conflict",
                "The map changed. Reload before starting analysis.",
              );
            const instance = yield* validateSelection(input.modelSelection);
            const existingRuns = yield* runs(checkout);
            const duplicate = existingRuns.find(
              (run) =>
                isCodebaseAnalysisActive(run.analysis.status) &&
                run.analysis.scopeId === input.scopeId &&
                run.analysis.sourceFingerprint === binding.sourceFingerprint &&
                run.analysis.expectedRevision === binding.expectedRevision &&
                run.analysis.parentRevision === binding.parentRevision &&
                run.analysis.configurationRevision === binding.configurationRevision &&
                run.analysis.gitHead === binding.gitHead &&
                run.analysis.gitBranch === binding.gitBranch &&
                sameSelection(run.modelSelection, input.modelSelection),
            );
            if (duplicate) return duplicate;
            if (
              existingRuns.filter((run) => isCodebaseAnalysisActive(run.analysis.status)).length >=
              40
            )
              return yield* failure(
                "busy",
                "This checkout already has 40 pending passes. Wait or cancel queued passes before adding more.",
              );
            const createdAt = yield* nowIso;
            const analysis: CodebaseAnalysis = {
              requestId: input.commandId,
              checkout,
              scopeId: input.scopeId,
              parentScopeId: input.parentScopeId,
              passKind: input.parentScopeId ? "detail" : "overview",
              status: "queued",
              expectedRevision: binding.expectedRevision,
              configurationRevision: binding.configurationRevision,
              parentRevision: binding.parentRevision,
              sourceFingerprint: binding.sourceFingerprint,
              gitHead: binding.gitHead,
              gitBranch: binding.gitBranch,
              analyzer: {
                driverKind: instance.driver,
                model: input.modelSelection.model,
                ...(input.modelSelection.options ? { options: input.modelSelection.options } : {}),
              },
              acceptedRevision: null,
              detail: null,
              updatedAt: createdAt,
            };
            yield* engine
              .dispatch({
                type: "thread.create",
                commandId: input.commandId,
                threadId,
                projectId: input.projectId,
                title: `Codebase: ${input.scopeId}`,
                modelSelection: input.modelSelection,
                runtimeMode: "approval-required",
                interactionMode: "default",
                branch: binding.gitBranch,
                worktreePath: checkout,
                createdAt,
                analysis,
              })
              .pipe(Effect.mapError(asError));
            yield* worker.enqueue(threadId);
            yield* PubSub.publish(changes, checkout);
            return {
              threadId,
              projectId: input.projectId,
              modelSelection: input.modelSelection,
              analysis,
            };
          }),
        );
      });
      const bindingsFor = Effect.fn("CodebaseService.bindingsFor")(function* (checkout: string) {
        const rows = yield* sql<{
          bindings_json: string;
        }>`SELECT bindings_json FROM codebase_analyzer_bindings WHERE checkout = ${checkout}`.pipe(
          Effect.mapError(asError),
        );
        return rows[0]
          ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CodebaseAnalyzerBindings))(
              rows[0].bindings_json,
            ).pipe(Effect.mapError(asError))
          : {};
      });
      const read = Effect.fn("CodebaseService.read")(function* (input: CodebaseReadInput) {
        const checkout = yield* resolve(input);
        const snapshot = yield* store.read({ checkout, scopeId: input.scopeId });
        const catalog = yield* registry.getProviders;
        const supportedProviderInstanceIds = [];
        for (const entry of catalog) {
          const capabilities = yield* provider
            .getCapabilities(entry.instanceId)
            .pipe(Effect.option);
          if (Option.isSome(capabilities) && capabilities.value.codebaseAnalysis)
            supportedProviderInstanceIds.push(entry.instanceId);
        }
        const worktrees = yield* Effect.gen(function* () {
          const root = (yield* vcs.run({
            operation: "codebase.worktrees.root",
            command: "git",
            args: ["rev-parse", "--show-toplevel"],
            cwd: checkout,
          })).stdout.trim();
          const relative = NodePath.relative(root, checkout);
          const listed = (yield* vcs.run({
            operation: "codebase.worktrees",
            command: "git",
            args: ["worktree", "list", "--porcelain", "-z"],
            cwd: checkout,
          })).stdout;
          const paths = listed
            .split("\0")
            .filter((part) => part.startsWith("worktree "))
            .map((part) => NodePath.join(part.slice(9), relative));
          const available = [];
          for (const path of paths) {
            const resolved = yield* canonical(path).pipe(Effect.option);
            if (Option.isSome(resolved)) available.push(resolved.value);
          }
          return available;
        }).pipe(Effect.catch(() => Effect.succeed([checkout])));
        return {
          ...snapshot,
          supportedProviderInstanceIds,
          worktrees,
          analyzerBindings: yield* bindingsFor(checkout),
        };
      });
      const configure = Effect.fn("CodebaseService.configure")(function* (
        input: CodebaseConfigureInput,
      ) {
        const checkout = yield* resolve(input);
        for (const [slot, selection] of Object.entries(input.analyzerBindings ?? {})) {
          if (!selection) continue;
          const instance = yield* validateSelection(selection);
          const preference = input.analyzers[slot as keyof typeof input.analyzers];
          if (
            !preference ||
            preference.driverKind !== instance.driver ||
            preference.model !== selection.model
          )
            return yield* failure(
              "invalid",
              "The local account must match the saved analyzer preference.",
            );
        }
        yield* store.configure(checkout, input.expectedRevision, input.analyzers);
        if (input.analyzerBindings) {
          const existing = yield* bindingsFor(checkout);
          const encoded = yield* Schema.encodeEffect(
            Schema.fromJsonString(CodebaseAnalyzerBindings),
          )({ ...existing, ...input.analyzerBindings }).pipe(Effect.mapError(asError));
          yield* sql`INSERT INTO codebase_analyzer_bindings (checkout, bindings_json) VALUES (${checkout}, ${encoded}) ON CONFLICT(checkout) DO UPDATE SET bindings_json = excluded.bindings_json`.pipe(
            Effect.mapError(asError),
          );
        }
        yield* PubSub.publish(changes, checkout);
        return yield* read({ ...input, checkout, scopeId: "overview" });
      });
      const cancel = Effect.fn("CodebaseService.cancel")(function* (input: CodebaseCancelInput) {
        return yield* mutex.withPermits(1)(
          Effect.gen(function* () {
            const checkout = yield* resolve(input);
            const thread = yield* threadById(input.runThreadId);
            if (thread.analysis!.checkout !== checkout)
              return yield* failure("unavailable", "This attempt belongs to another checkout.");
            if (!isCodebaseAnalysisActive(thread.analysis!.status)) return toRun(thread);
            const cancelled = yield* update(thread, {
              status: "cancelled",
              detail: "Cancelled before acceptance.",
            });
            yield* engine
              .dispatch({
                type: "thread.turn.interrupt",
                commandId: CommandId.make(NodeCrypto.randomUUID()),
                threadId: thread.id,
                createdAt: yield* nowIso,
              })
              .pipe(Effect.mapError(asError));
            return toRun(cancelled);
          }),
        );
      });
      const status = Effect.fn("CodebaseService.status")(function* (input: CodebaseCheckoutInput) {
        const checkout = yield* resolve(input);
        return { checkout, runs: yield* runs(checkout), artifactsChanged: false };
      });
      const subscribe = Effect.fn("CodebaseService.subscribe")(function* (
        input: CodebaseCheckoutInput,
      ) {
        const checkout = yield* resolve(input);
        const subscription = yield* PubSub.subscribe(changes);
        const changed = yield* PubSub.sliding<void>({ capacity: 1 });
        const localSubscription = yield* PubSub.subscribe(changed);
        let diskRevision = NodeCrypto.randomUUID();
        const signal = () => {
          diskRevision = NodeCrypto.randomUUID();
          Effect.runSync(PubSub.publish(changed, undefined));
        };
        const gitDirectory = yield* vcs
          .run({
            operation: "codebase.watch",
            command: "git",
            args: ["rev-parse", "--absolute-git-dir"],
            cwd: checkout,
          })
          .pipe(
            Effect.map((result) => result.stdout.trim()),
            Effect.option,
          );
        if (Option.isSome(gitDirectory)) {
          yield* Effect.acquireRelease(
            Effect.try({
              try: () =>
                NodeFS.watch(gitDirectory.value, (_event, path) => {
                  if (["HEAD", "index", "packed-refs"].includes(path?.toString() ?? "")) signal();
                }).on("error", signal),
              catch: asError,
            }),
            (watcher) => Effect.sync(() => watcher.close()),
          );
        }
        yield* Effect.acquireRelease(
          Effect.try({
            try: () =>
              NodeFS.watch(checkout, { recursive: true }, (_event, path) => {
                const name = path?.toString().replaceAll("\\", "/") ?? "";
                if (
                  (!name.startsWith(".t3-codebase/") && isExcludedCodebaseSource(name)) ||
                  name.includes(".write-lock") ||
                  name.endsWith(".tmp")
                )
                  return;
                signal();
              }).on("error", signal),
            catch: asError,
          }),
          (watcher) => Effect.sync(() => watcher.close()),
        );
        const progress = () =>
          runs(checkout).pipe(
            Effect.map((entries) => ({
              checkout,
              runs: entries,
              artifactsChanged: false,
              diskRevision,
            })),
          );
        return Stream.concat(
          Stream.fromEffect(progress()),
          Stream.merge(
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((value) => value === checkout),
              Stream.mapEffect(progress),
            ),
            Stream.fromSubscription(localSubscription).pipe(
              Stream.debounce("200 millis"),
              Stream.mapEffect(() =>
                progress().pipe(Effect.map((value) => ({ ...value, artifactsChanged: true }))),
              ),
            ),
          ),
        );
      });
      const start = Effect.fn("CodebaseService.start")(function* () {
        yield* Stream.runForEach(engine.streamDomainEvents, (event) =>
          Effect.gen(function* () {
            if (event.aggregateKind !== "thread") return;
            if (
              ![
                "thread.created",
                "thread.session-set",
                "thread.turn-diff-completed",
                "thread.message-sent",
                "thread.activity-appended",
                "thread.analysis-set",
              ].includes(event.type)
            )
              return;
            const shell = yield* query
              .getThreadShellById(ThreadId.make(event.aggregateId))
              .pipe(Effect.catch(() => Effect.succeed(Option.none())));
            if (Option.isNone(shell) || !shell.value.analysis) return;
            yield* PubSub.publish(changes, shell.value.analysis.checkout);
            if (event.type !== "thread.analysis-set" && !recovering)
              yield* worker.enqueue(shell.value.id);
            else if (!recovering && !isCodebaseAnalysisActive(shell.value.analysis.status)) {
              const queued = (yield* runs(shell.value.analysis.checkout))
                .filter((run) => run.analysis.status === "queued")
                .reverse();
              if (queued[0]) yield* worker.enqueue(queued[0].threadId);
            }
          }).pipe(Effect.catch(Effect.logWarning)),
        ).pipe(Effect.forkScoped);
        yield* Effect.gen(function* () {
          for (const run of yield* runs()) {
            yield* Effect.gen(function* () {
              const thread = yield* threadById(run.threadId);
              if (run.analysis.status === "saving") {
                const map = yield* store.read({
                  checkout: run.analysis.checkout,
                  scopeId: run.analysis.scopeId,
                });
                if (map.revision === run.analysis.acceptedRevision) {
                  yield* update(thread, { status: "succeeded", detail: null });
                  return;
                }
                yield* failAttempt(
                  thread,
                  failure(
                    "conflict",
                    "The map changed after publication began. Reload it and retry explicitly.",
                  ),
                );
                return;
              }
              yield* processAttempt(run.threadId, true).pipe(
                Effect.catch((cause) =>
                  Effect.gen(function* () {
                    yield* provider
                      .interruptTurn({ threadId: run.threadId })
                      .pipe(Effect.catch(() => Effect.void));
                    yield* failAttempt(yield* threadById(run.threadId), cause);
                  }),
                ),
              );
            }).pipe(Effect.catch(Effect.logWarning));
          }
        }).pipe(Effect.catch(Effect.logWarning));
        recovering = false;
      });
      return {
        read,
        configure,
        startAnalysis,
        cancel,
        status,
        subscribe,
        start,
        drain: worker.drain,
      };
    }),
  );
}
