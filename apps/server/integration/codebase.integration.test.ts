// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";
import { afterEach, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodebaseArtifactStore } from "../src/codebase/CodebaseArtifactStore.ts";
import * as VcsProcess from "../src/vcs/VcsProcess.ts";
import * as ProcessRunner from "../src/processRunner.ts";
import * as Layer from "effect/Layer";
import { CodebaseGraph, ProviderDriverKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Deferred from "effect/Deferred";
import {
  CommandId,
  ProjectId,
  DEFAULT_MODEL,
  EventId,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import { makeOrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const storeLayer = CodebaseArtifactStore.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(ProcessRunner.layer),
  Layer.provide(NodeServices.layer),
);

it.live(
  "publishes a portable map, keeps it fresh after a map-only commit, and rejects changed inputs",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-codebase-test-")),
      );
      roots.push(root);
      git(root, "init", "-b", "main");
      git(root, "config", "user.name", "Codebase Test");
      git(root, "config", "user.email", "test@example.invalid");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "app.ts"), "export const app = 1;\n"),
      );
      git(root, "add", "app.ts");
      git(root, "commit", "-m", "source");
      yield* Effect.gen(function* () {
        const store = yield* CodebaseArtifactStore;
        const before = yield* store.read({ checkout: root, scopeId: "overview" });
        expect(before.state).toBe("unbuilt");
        const binding = yield* store.prepare({
          checkout: root,
          scopeId: "overview",
          parentScopeId: null,
        });
        const graph = {
          title: "App",
          summary: "One module",
          nodes: [
            {
              id: "app",
              kind: "module",
              name: "App",
              responsibility: "Exports app",
              explanation: "The module exports the application value.",
              technologies: ["TypeScript"],
              sources: [{ path: "app.ts", startLine: 1, endLine: 1 }],
              expandable: true,
            },
          ],
          edges: [],
          omissions: [],
        };
        const output = yield* Schema.encodeEffect(Schema.fromJsonString(CodebaseGraph))(graph);
        const document = yield* store.validate(binding, output, {
          driverKind: ProviderDriverKind.make("codex"),
          model: "test-model",
        });
        yield* store.publish(binding, document);
        const accepted = yield* store.read({ checkout: root, scopeId: "overview" });
        expect(accepted.state).toBe("ready");
        expect(accepted.freshness).toBe("current");
        git(root, "add", ".t3-codebase");
        git(root, "commit", "-m", "map");
        expect((yield* store.read({ checkout: root, scopeId: "overview" })).freshness).toBe(
          "current",
        );
        const refresh = yield* store.prepare({
          checkout: root,
          scopeId: "overview",
          parentScopeId: null,
        });
        const regenerated = yield* store.validate(
          refresh,
          yield* Schema.encodeEffect(Schema.fromJsonString(CodebaseGraph))({
            ...graph,
            nodes: graph.nodes.map((node) => ({ ...node, id: "provider-changed-id" })),
          }),
          document.provenance.analyzer,
        );
        expect(regenerated.graph.nodes[0]?.id).toBe(document.graph.nodes[0]?.id);
        expect(regenerated.graph.nodes[0]?.childScopeId).toBe(
          document.graph.nodes[0]?.childScopeId,
        );
        for (const invalidOutput of [
          "{",
          " ".repeat(600_000),
          output.replace('"startLine":1', '"startLine":99999'),
        ]) {
          expect(
            (yield* Effect.result(
              store.validate(refresh, invalidOutput, document.provenance.analyzer),
            ))._tag,
          ).toBe("Failure");
        }
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(root, "app.ts"), "export const app = 2;\n"),
        );
        expect((yield* store.read({ checkout: root, scopeId: "overview" })).freshness).toBe(
          "stale",
        );
        const outcome = yield* Effect.result(store.publish(refresh, document));
        expect(outcome._tag).toBe("Failure");
        expect((yield* store.read({ checkout: root, scopeId: "overview" })).revision).toBe(
          accepted.revision,
        );
      }).pipe(Effect.provide(storeLayer));
    }),
);

it.live(
  "builds an overview through orchestration and exposes the accepted map without adding a conversation",
  () =>
    Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.acquireUseRelease(
          makeOrchestrationIntegrationHarness(),
          (harness) =>
            Effect.gen(function* () {
              const projectId = ProjectId.make("codebase-project");
              const driver = ProviderDriverKind.make("codex");
              const selection = {
                instanceId: defaultInstanceIdForDriver(driver),
                model: DEFAULT_MODEL,
              };
              const createdAt = "2026-10-25T00:00:00.000Z";
              yield* harness.engine.dispatch({
                type: "project.create",
                commandId: CommandId.make("create-project"),
                projectId,
                title: "Codebase integration",
                workspaceRoot: harness.workspaceDir,
                defaultModelSelection: selection,
                createdAt,
              });
              const configured = yield* harness.codebase.configure({
                projectId,
                expectedRevision: null,
                analyzers: { default: { driverKind: driver, model: selection.model } },
                analyzerBindings: { default: selection },
              });
              expect(configured.analyzerBindings?.default).toEqual(selection);
              expect(configured.manifest?.analyzers.default).not.toHaveProperty("instanceId");
              const output = yield* Schema.encodeEffect(Schema.fromJsonString(CodebaseGraph))({
                title: "Project",
                summary: "A documented project.",
                nodes: [
                  {
                    id: "readme",
                    kind: "documentation",
                    name: "README",
                    responsibility: "Introduces the project",
                    explanation: "The readme describes the repository.",
                    technologies: [],
                    sources: [{ path: "README.md", startLine: 1, endLine: 1 }],
                    expandable: true,
                  },
                ],
                edges: [],
                omissions: [],
              });
              yield* harness.adapterHarness!.queueTurnResponseForNextSession({
                events: [
                  {
                    type: "turn.started",
                    eventId: EventId.make("start"),
                    provider: driver,
                    createdAt,
                    threadId: "fixture",
                    turnId: "fixture-turn",
                  },
                  {
                    type: "message.delta",
                    eventId: EventId.make("output"),
                    provider: driver,
                    createdAt,
                    threadId: "fixture",
                    turnId: "fixture-turn",
                    delta: output,
                  },
                  {
                    type: "turn.completed",
                    eventId: EventId.make("done"),
                    provider: driver,
                    createdAt,
                    threadId: "fixture",
                    turnId: "fixture-turn",
                    status: "completed",
                  },
                ],
              });
              const progress = yield* harness.codebase.subscribe({ projectId });
              const input = {
                projectId,
                scopeId: "overview",
                parentScopeId: null,
                expectedRevision: null,
                commandId: CommandId.make("build-overview"),
                modelSelection: selection,
              };
              const run = yield* harness.codebase.startAnalysis(input);
              expect((yield* harness.codebase.startAnalysis(input)).threadId).toBe(run.threadId);
              const terminal = yield* Stream.runHead(
                progress.pipe(
                  Stream.filter((value) =>
                    value.runs.some(
                      (entry) =>
                        entry.threadId === run.threadId &&
                        ["succeeded", "failed", "input-changed"].includes(entry.analysis.status),
                    ),
                  ),
                ),
              );
              expect(
                Option.isSome(terminal) ? terminal.value.runs[0]?.analysis : null,
              ).toMatchObject({ status: "succeeded" });
              const finish = (
                text: string,
                suffix: string,
                mutateWorkspace?: () => Effect.Effect<void>,
              ) =>
                harness.adapterHarness!.queueTurnResponseForNextSession({
                  ...(mutateWorkspace ? { mutateWorkspace } : {}),
                  events: [
                    {
                      type: "turn.started",
                      eventId: EventId.make(`start-${suffix}`),
                      provider: driver,
                      createdAt,
                      threadId: "fixture",
                      turnId: `turn-${suffix}`,
                    },
                    {
                      type: "message.delta",
                      eventId: EventId.make(`output-${suffix}`),
                      provider: driver,
                      createdAt,
                      threadId: "fixture",
                      turnId: `turn-${suffix}`,
                      delta: text,
                    },
                    {
                      type: "turn.completed",
                      eventId: EventId.make(`done-${suffix}`),
                      provider: driver,
                      createdAt,
                      threadId: "fixture",
                      turnId: `turn-${suffix}`,
                      status: "completed",
                    },
                  ],
                });
              const awaitAttempt = (threadId: typeof run.threadId) =>
                Effect.gen(function* () {
                  const events = yield* harness.codebase.subscribe({ projectId });
                  const settled = yield* Stream.runHead(
                    events.pipe(
                      Stream.filter((value) =>
                        value.runs.some(
                          (entry) =>
                            entry.threadId === threadId &&
                            !["queued", "running", "waiting", "validating", "saving"].includes(
                              entry.analysis.status,
                            ),
                        ),
                      ),
                    ),
                  );
                  return Option.isSome(settled)
                    ? settled.value.runs.find((entry) => entry.threadId === threadId)
                    : undefined;
                });
              const map = yield* harness.codebase.read({ projectId, scopeId: "overview" });
              expect(map.state).toBe("ready");
              expect(map.scope?.graph.nodes[0]?.childScopeId).toBeTruthy();
              expect(map.scope?.provenance.analyzer.model).toBe(DEFAULT_MODEL);
              expect((yield* harness.snapshotQuery.getShellSnapshot()).threads).toHaveLength(0);
              let parent = "overview";
              let nextScope = map.scope!.graph.nodes[0]!.childScopeId!;
              for (const suffix of ["modules", "functions"]) {
                yield* finish(output, suffix);
                const child = yield* harness.codebase.startAnalysis({
                  ...input,
                  scopeId: nextScope,
                  parentScopeId: parent,
                  commandId: CommandId.make(suffix),
                });
                const settled = yield* awaitAttempt(child.threadId);
                expect(settled?.analysis.status, settled?.analysis.detail ?? "Child pass").toBe(
                  "succeeded",
                );
                const layer = yield* harness.codebase.read({ projectId, scopeId: nextScope });
                expect(layer.scope?.parentScopeId).toBe(parent);
                parent = nextScope;
                nextScope = layer.scope!.graph.nodes[0]!.childScopeId!;
                expect(nextScope).not.toBe(parent);
              }
              yield* finish("{invalid", "invalid");
              const invalid = yield* harness.codebase.startAnalysis({
                ...input,
                expectedRevision: map.revision,
                commandId: CommandId.make("invalid"),
              });
              expect((yield* awaitAttempt(invalid.threadId))?.analysis.status).toBe("failed");
              expect(
                (yield* harness.codebase.read({ projectId, scopeId: "overview" })).revision,
              ).toBe(map.revision);
              const entered = yield* Deferred.make<void>();
              const release = yield* Deferred.make<void>();
              yield* finish(output, "cancel", () =>
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
              );
              const pending = yield* harness.codebase.startAnalysis({
                ...input,
                expectedRevision: map.revision,
                commandId: CommandId.make("cancel"),
              });
              yield* Deferred.await(entered);
              const attached = yield* harness.codebase.startAnalysis({
                ...input,
                expectedRevision: map.revision,
                commandId: CommandId.make("attach"),
              });
              expect(attached.threadId).toBe(pending.threadId);
              const mismatched = yield* Effect.result(
                harness.codebase.startAnalysis({
                  ...input,
                  scopeId: "other",
                  commandId: CommandId.make("cancel"),
                }),
              );
              expect(mismatched._tag).toBe("Failure");
              expect(
                (yield* harness.codebase.cancel({ projectId, runThreadId: pending.threadId }))
                  .analysis.status,
              ).toBe("cancelled");
              yield* Deferred.succeed(release, undefined);
              yield* harness.codebase.drain;
              expect((yield* awaitAttempt(pending.threadId))?.analysis.status).toBe("cancelled");
              expect(
                (yield* harness.codebase.read({ projectId, scopeId: "overview" })).revision,
              ).toBe(map.revision);
              const startupFailure = yield* harness.codebase.startAnalysis({
                ...input,
                expectedRevision: map.revision,
                commandId: CommandId.make("no-provider-response"),
              });
              expect((yield* awaitAttempt(startupFailure.threadId))?.analysis.status).toBe(
                "failed",
              );
              expect(
                (yield* harness.codebase.read({ projectId, scopeId: "overview" })).revision,
              ).toBe(map.revision);
              expect(
                (yield* Effect.result(
                  harness.engine.dispatch({
                    type: "thread.meta.update",
                    commandId: CommandId.make("cannot-rebind-analysis"),
                    threadId: run.threadId,
                    worktreePath: "/another-checkout",
                  }),
                ))._tag,
              ).toBe("Failure");
              const detail = yield* harness.snapshotQuery.getThreadDetailById(run.threadId);
              expect(
                Option.isSome(detail) &&
                  detail.value.messages.some((message) => message.role === "assistant"),
              ).toBe(true);
            }),
          (harness) => harness.dispose,
        ),
      ).pipe(Effect.provide(NodeServices.layer));
    }),
  60_000,
);

it.live(
  "loads portable scopes in another clone and follows branch, worktree, subproject, and corruption states",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-codebase-portable-")),
      );
      const worktree = `${root}-other`;
      const clone = `${root}-clone`;
      roots.push(root, worktree, clone);
      git(root, "init", "-b", "main");
      git(root, "config", "user.name", "Codebase Test");
      git(root, "config", "user.email", "test@example.invalid");
      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(root, "app")));
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "app", "index.ts"), "export const value = 1;\n"),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(root, "app", "deps.lock"), "version=1\n"),
      );
      git(root, "add", ".");
      git(root, "commit", "-m", "source");
      const sourceCommit = git(root, "rev-parse", "HEAD");
      git(root, "worktree", "add", "-b", "other", worktree);
      const checkout = NodePath.join(root, "app");
      yield* Effect.gen(function* () {
        const store = yield* CodebaseArtifactStore;
        const binding = yield* store.prepare({
          checkout,
          scopeId: "overview",
          parentScopeId: null,
        });
        expect(binding.projectPath).toBe("app");
        expect(binding.inventory.some((file) => file.path === "deps.lock")).toBe(true);
        const graph = {
          title: "App",
          summary: "A library",
          nodes: [
            {
              id: "value",
              kind: "module",
              name: "Value",
              responsibility: "Exports a value",
              explanation: "The library exports a value.",
              technologies: ["TypeScript"],
              sources: [{ path: "index.ts", startLine: 1, endLine: 1, symbol: "value" }],
              expandable: false,
            },
          ],
          edges: [],
          omissions: [],
        };
        const output = yield* Schema.encodeEffect(Schema.fromJsonString(CodebaseGraph))(graph);
        const document = yield* store.validate(binding, output, {
          driverKind: ProviderDriverKind.make("codex"),
          model: "fixture",
        });
        yield* store.publish(binding, document);
        expect(
          (yield* store.read({ checkout: NodePath.join(worktree, "app"), scopeId: "overview" }))
            .state,
        ).toBe("unbuilt");
        git(root, "add", "app/.t3-codebase");
        git(root, "commit", "-m", "accepted map");
        const mappedCommit = git(root, "rev-parse", "HEAD");
        git(root, "clone", "--no-hardlinks", root, clone);
        const portable = yield* store.read({
          checkout: NodePath.join(clone, "app"),
          scopeId: "overview",
        });
        expect(portable.state).toBe("ready");
        expect(portable.scope?.graph).toEqual(document.graph);
        const bound = yield* store.prepare({ checkout, scopeId: "overview", parentScopeId: null });
        git(root, "checkout", "--detach", sourceCommit);
        expect((yield* store.read({ checkout, scopeId: "overview" })).state).toBe("unbuilt");
        expect((yield* Effect.result(store.publish(bound, document)))._tag).toBe("Failure");
        git(root, "checkout", "--detach", mappedCommit);
        const detached = yield* store.read({ checkout, scopeId: "overview" });
        expect(detached.branch).toBeNull();
        expect(detached.freshness).toBe("current");
        const old = yield* store.prepare({ checkout, scopeId: "overview", parentScopeId: null });
        const mapPath = NodePath.join(checkout, ".t3-codebase", "scopes", "overview.json");
        const original = yield* Effect.promise(() => NodeFSP.readFile(mapPath, "utf8"));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(mapPath, original.replace("A library", "Hand edited")),
        );
        expect((yield* Effect.result(store.publish(old, document)))._tag).toBe("Failure");
        expect((yield* store.read({ checkout, scopeId: "overview" })).scope?.graph.summary).toBe(
          "Hand edited",
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(mapPath, original.replace('"version": 1', '"version": 99')),
        );
        expect((yield* store.read({ checkout, scopeId: "overview" })).state).toBe("unsupported");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(mapPath, "<<<<<<< ours\n=======\n>>>>>>> theirs\n"),
        );
        expect((yield* store.read({ checkout, scopeId: "overview" })).state).toBe("conflicted");
        yield* Effect.promise(() => NodeFSP.writeFile(mapPath, "{"));
        expect((yield* store.read({ checkout, scopeId: "overview" })).state).toBe("invalid");
        expect((yield* Effect.result(store.publish(old, document)))._tag).toBe("Failure");
        expect(yield* Effect.promise(() => NodeFSP.readFile(mapPath, "utf8"))).toBe("{");
        yield* Effect.promise(() => NodeFSP.writeFile(mapPath, original));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(checkout, "deps.lock"), "version=2\n"),
        );
        expect((yield* store.read({ checkout, scopeId: "overview" })).freshness).toBe("stale");
      }).pipe(Effect.provide(storeLayer));
    }),
  60_000,
);
