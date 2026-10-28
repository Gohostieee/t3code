// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId } from "@t3tools/contracts";
import { atlasDirectory } from "../src/codebase/AtlasStorage.ts";
import { makeOrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";

it.live("indexes actual routes and component evidence without a provider turn", () =>
  Effect.gen(function* () {
    const harness = yield* makeOrchestrationIntegrationHarness();
    yield* Effect.gen(function* () {
      const projectId = ProjectId.make("atlas-project");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(harness.workspaceDir, ".t3-codebase"), {
          recursive: true,
        });
        await NodeFSP.writeFile(
          NodePath.join(harness.workspaceDir, ".t3-codebase/manifest.json"),
          "invalid legacy data",
        );
        for (const [path, source] of Object.entries({
          "package.json": '{"dependencies":{"next":"16.4.3"}}',
          "tsconfig.json":
            '{"compilerOptions":{"jsx":"preserve","baseUrl":".","paths":{"@/*":["./*"]}}}',
          "app/layout.tsx":
            "export default function Layout({children}) { return <main>{children}</main> }",
          "app/(work)/projects/[id]/page.tsx":
            "import { Panel } from '@/ui/Panel'; export default function Page() { return <Panel/> }",
          "app/(work)/projects/loading.tsx":
            "export default function Loading() { return <p>Loading</p> }",
          "app/api/projects/route.ts": "export async function GET() { return Response.json([]) }",
          "ui/Panel.tsx": "export function Panel() { return <h1>Project</h1> }",
        })) {
          const absolute = NodePath.join(harness.workspaceDir, path);
          await NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true });
          await NodeFSP.writeFile(absolute, source);
        }
      });
      yield* harness.engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("atlas-project"),
        projectId,
        title: "Atlas",
        workspaceRoot: harness.workspaceDir,
        createdAt: "2026-10-27T00:00:00.000Z",
      });
      yield* harness.codebase.atlas({
        projectId,
        action: { type: "index", commandId: CommandId.make("atlas-index"), expectedRevision: null },
        appRoot: ".",
      });
      yield* harness.codebase.drain;
      const snapshot = yield* harness.codebase.atlas({
        projectId,
        appRoot: ".",
        action: { type: "read" },
      });
      expect(snapshot.state).toBe("ready");
      expect(snapshot.freshness).toBe("current");
      expect(
        snapshot.nodes.find((node) => node.kind === "route" && node.pattern === "/projects/[id]")
          ?.parameters,
      ).toEqual([{ name: "id", kind: "single" }]);
      expect(snapshot.nodes.find((node) => node.kind === "endpoint")?.methods).toEqual(["GET"]);
      const page = snapshot.nodes.find((node) => node.kind === "route");
      expect(page?.layouts).toHaveLength(1);
      expect(page?.boundaries).toHaveLength(1);
      expect(
        snapshot.edges.some(
          (edge) => edge.kind === "jsx-uses" && edge.source.path.endsWith("page.tsx"),
        ),
      ).toBe(true);
      expect(snapshot.jobs[0]?.status).toBe("completed");
      expect((yield* harness.codebase.status({ projectId })).runs).toHaveLength(0);
      expect(snapshot.coverage.parsedFiles).toBe(5);
      yield* harness.codebase.atlas({
        projectId,
        appRoot: ".",
        action: {
          type: "index",
          commandId: CommandId.make("atlas-index-repeat"),
          expectedRevision: snapshot.revision,
        },
      });
      yield* harness.codebase.drain;
      expect(
        (yield* harness.codebase.atlas({ projectId, appRoot: ".", action: { type: "read" } }))
          .revision,
      ).toBe(snapshot.revision);
      const docs = {
        version: 1 as const,
        features: [
          {
            id: "projects",
            name: "Projects",
            description: "User-authored capability",
            members: [page!.id],
          },
        ],
        scenarios: [
          {
            id: "project-page",
            routeId: page!.id,
            name: "Project",
            parameters: { id: "42" },
            query: {},
            viewport: "desktop" as const,
            theme: "light" as const,
            readiness: { kind: "text" as const, value: "Project" },
          },
        ],
      };
      const saved = yield* harness.codebase.atlas({
        projectId,
        appRoot: ".",
        action: { type: "documentation", expectedRevision: null, documentation: docs },
      });
      expect(saved.documentation.features[0]?.name).toBe("Projects");
      expect(
        (yield* harness.codebase.atlas({
          projectId,
          action: { type: "read" },
          view: "routes",
          ungrouped: true,
        })).nodes.some((node) => node.id === page!.id),
      ).toBe(false);
      const staleSave = yield* Effect.result(
        harness.codebase.atlas({
          projectId,
          action: {
            type: "documentation",
            expectedRevision: null,
            documentation: { ...docs, features: [] },
          },
        }),
      );
      expect(staleSave._tag).toBe("Failure");
      expect(
        (yield* harness.codebase.atlas({ projectId, action: { type: "read" } })).documentation
          .features[0]?.name,
      ).toBe("Projects");
      const attached = yield* harness.codebase.atlas({
        projectId,
        appRoot: ".",
        action: { type: "attach", origin: "http://localhost:4321", prefix: "" },
      });
      expect(attached.target?.provenance).toBe("user-confirmed; running source unverified");
      const changedCommand = yield* Effect.result(
        harness.codebase.atlas({
          projectId,
          action: {
            type: "index",
            commandId: CommandId.make("atlas-index"),
            expectedRevision: snapshot.revision,
          },
        }),
      );
      expect(changedCommand._tag).toBe("Failure");
      const directory = atlasDirectory(harness.workspaceDir, ".");
      const portable = yield* Effect.promise(async () =>
        (await NodeFSP.readdir(directory)).filter((name) => name.endsWith(".json")),
      );
      const portableText = yield* Effect.promise(async () =>
        (
          await Promise.all(
            portable.map((name) => NodeFSP.readFile(NodePath.join(directory, name), "utf8")),
          )
        ).join("\n"),
      );
      expect(portableText).not.toContain("localhost:4321");
      expect(portableText).not.toContain("updatedAt");
      const clone = NodePath.join(harness.rootDir, "atlas-clone");
      yield* Effect.promise(async () => {
        NodeChildProcess.execFileSync("git", ["add", "--all"], { cwd: harness.workspaceDir });
        NodeChildProcess.execFileSync("git", ["commit", "-m", "portable atlas fixture"], {
          cwd: harness.workspaceDir,
          stdio: "ignore",
        });
        NodeChildProcess.execFileSync(
          "git",
          ["-c", "core.autocrlf=true", "clone", harness.workspaceDir, clone],
          {
            stdio: "ignore",
          },
        );
      });
      const cloneProject = ProjectId.make("atlas-clone");
      yield* harness.engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("clone-project"),
        projectId: cloneProject,
        title: "Clone",
        workspaceRoot: clone,
        createdAt: "2026-10-27T00:00:00.000Z",
      });
      const cloned = yield* harness.codebase.atlas({
        projectId: cloneProject,
        action: { type: "read" },
      });
      expect(cloned.revision).toBe(snapshot.revision);
      expect(cloned.freshness).toBe("current");
      expect(cloned.documentation.features[0]?.members).toEqual([page!.id]);
      expect(cloned.documentation.scenarios[0]?.id).toBe("project-page");
      expect(cloned.jobs).toEqual([]);
      expect(cloned.target).toBeNull();
      expect(cloned.sessions).toEqual([]);
      expect(cloned.captures).toEqual([]);
      const manifest = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(directory, "manifest.json"), "utf8"),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(directory, "manifest.json"), "<<<<<<< conflict\n"),
      );
      expect((yield* harness.codebase.atlas({ projectId, action: { type: "read" } })).state).toBe(
        "invalid",
      );
      expect(
        (yield* Effect.result(
          harness.codebase.atlas({
            projectId,
            action: {
              type: "index",
              commandId: CommandId.make("invalid-retry"),
              expectedRevision: snapshot.revision,
            },
          }),
        ))._tag,
      ).toBe("Failure");
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(directory, "manifest.json"), "utf8"),
        ),
      ).toBe("<<<<<<< conflict\n");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(directory, "manifest.json"), manifest),
      );
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(harness.workspaceDir, "app/oversized"), {
          recursive: true,
        });
        await NodeFSP.writeFile(
          NodePath.join(harness.workspaceDir, "app/oversized/page.tsx"),
          "/*" + "x".repeat(1024 * 1024) + "*/",
        );
        await NodeFSP.writeFile(
          NodePath.join(harness.workspaceDir, "types.ts"),
          "export type Model = string; export const value = 1;",
        );
        await NodeFSP.writeFile(
          NodePath.join(harness.workspaceDir, "uses.ts"),
          "import { type Model, value } from './types'; export const item: Model = String(value);",
        );
      });
      yield* harness.codebase.atlas({
        projectId,
        action: {
          type: "index",
          commandId: CommandId.make("partial-index"),
          expectedRevision: snapshot.revision,
        },
      });
      yield* harness.codebase.drain;
      const partial = yield* harness.codebase.atlas({
        projectId,
        action: { type: "read" },
        view: "all",
      });
      expect(partial.coverage.partial).toBe(true);
      expect(partial.diagnostics.some((diagnostic) => diagnostic.code === "excluded-source")).toBe(
        true,
      );
      const typedEdges = partial.edges.filter((edge) => edge.source.path === "uses.ts");
      expect(typedEdges.some((edge) => edge.kind === "imports")).toBe(true);
      expect(typedEdges.some((edge) => edge.kind === "type-dependency")).toBe(true);
      yield* Effect.promise(async () => {
        for (let index = 0; index < 9; index++)
          await NodeFSP.writeFile(
            NodePath.join(harness.workspaceDir, `budget-${index}.ts`),
            "/*" + "x".repeat(980000) + "*/export const value = 1;",
          );
      });
      yield* harness.codebase.atlas({
        projectId,
        action: {
          type: "index",
          commandId: CommandId.make("overflow-index"),
          expectedRevision: partial.revision,
        },
      });
      yield* harness.codebase.drain;
      const overflow = yield* harness.codebase.atlas({ projectId, action: { type: "read" } });
      expect(overflow.jobs[0]?.status).toBe("failed");
      expect(overflow.jobs[0]?.detail).toContain("8 MiB parser budget");
      expect(overflow.revision).toBe(partial.revision);
    }).pipe(Effect.ensuring(harness.dispose));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("cancels indexing through durable progress without losing the accepted atlas", () =>
  Effect.gen(function* () {
    const harness = yield* makeOrchestrationIntegrationHarness();
    yield* Effect.gen(function* () {
      const projectId = ProjectId.make("atlas-cancel");
      yield* harness.engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cancel-project"),
        projectId,
        title: "Cancellation",
        workspaceRoot: harness.workspaceDir,
        createdAt: "2026-10-27T00:00:00.000Z",
      });
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(harness.workspaceDir, "main.ts"),
          "export const before = 1;",
        ),
      );
      yield* harness.codebase.atlas({
        projectId,
        action: { type: "index", commandId: CommandId.make("first"), expectedRevision: null },
      });
      yield* harness.codebase.drain;
      const first = yield* harness.codebase.atlas({ projectId, action: { type: "read" } });
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(harness.workspaceDir, "main.ts"),
          "export const after = 2;",
        ),
      );
      const stream = yield* harness.codebase.subscribe({ projectId });
      const entered = yield* Stream.runHead(
        stream.pipe(
          Stream.filter(
            (progress) => !!progress.atlasJobs?.some((job) => job.status === "parsing"),
          ),
        ),
      ).pipe(Effect.forkChild);
      yield* harness.codebase.atlas({
        projectId,
        action: {
          type: "index",
          commandId: CommandId.make("cancel-me"),
          expectedRevision: first.revision,
        },
      });
      const progress = Option.getOrThrow(yield* Fiber.join(entered));
      const job = progress.atlasJobs!.find((entry) => entry.status === "parsing")!;
      yield* harness.codebase.atlas({ projectId, action: { type: "cancel", jobId: job.id } });
      yield* harness.codebase.drain;
      const cancelled = yield* harness.codebase.atlas({ projectId, action: { type: "read" } });
      expect(cancelled.jobs[0]?.status).toBe("cancelled");
      expect(cancelled.revision).toBe(first.revision);
      expect(cancelled.freshness).toBe("stale");
    }).pipe(Effect.ensuring(harness.dispose));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "keeps TanStack pathless parents as layouts and preserves feature references after source removal",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeOrchestrationIntegrationHarness();
      yield* Effect.gen(function* () {
        const projectId = ProjectId.make("tanstack-atlas");
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(
            NodePath.join(harness.workspaceDir, "package.json"),
            '{"dependencies":{"@tanstack/react-router":"1.170.10"}}',
          );
          await NodeFSP.mkdir(NodePath.join(harness.workspaceDir, "src/routes"), {
            recursive: true,
          });
          await NodeFSP.writeFile(
            NodePath.join(harness.workspaceDir, "src/routes/_chat.tsx"),
            "import {createFileRoute} from '@tanstack/react-router'; export const Route=createFileRoute('/_chat')({component:Shell}); function Shell(){return <main/>}",
          );
          await NodeFSP.writeFile(
            NodePath.join(harness.workspaceDir, "src/routes/_chat.projects.$id.tsx"),
            "import {createFileRoute} from '@tanstack/react-router'; export const Route=createFileRoute('/_chat/projects/$id')({component:Page,pendingComponent:()=> <p>Loading</p>}); function Page(){return <h1>Project</h1>}",
          );
        });
        yield* harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("tanstack-project"),
          projectId,
          title: "TanStack",
          workspaceRoot: harness.workspaceDir,
          createdAt: "2026-10-27T00:00:00.000Z",
        });
        yield* harness.codebase.atlas({
          projectId,
          action: {
            type: "index",
            commandId: CommandId.make("tanstack-index"),
            expectedRevision: null,
          },
        });
        yield* harness.codebase.drain;
        const first = yield* harness.codebase.atlas({ projectId, action: { type: "read" } });
        expect(first.nodes.filter((n) => n.kind === "route").map((n) => n.pattern)).toEqual([
          "/projects/$id",
        ]);
        const page = first.nodes.find((n) => n.kind === "route")!;
        expect(page.layouts).toHaveLength(1);
        expect(page.boundaries).toHaveLength(1);
        expect(
          first.edges.some(
            (edge) =>
              edge.from === page.id &&
              edge.kind === "route-entry" &&
              first.nodes.find((node) => node.id === edge.to)?.kind === "component",
          ),
        ).toBe(true);
        yield* harness.codebase.atlas({
          projectId,
          action: {
            type: "documentation",
            expectedRevision: null,
            documentation: {
              version: 1,
              features: [{ id: "projects", name: "Projects", description: "", members: [page.id] }],
              scenarios: [],
            },
          },
        });
        yield* Effect.promise(() =>
          NodeFSP.unlink(NodePath.join(harness.workspaceDir, "src/routes/_chat.projects.$id.tsx")),
        );
        expect(
          (yield* harness.codebase.atlas({ projectId, action: { type: "read" } })).freshness,
        ).toBe("stale");
        yield* harness.codebase.atlas({
          projectId,
          action: {
            type: "index",
            commandId: CommandId.make("tanstack-reindex"),
            expectedRevision: first.revision,
          },
        });
        yield* harness.codebase.drain;
        const refreshed = yield* harness.codebase.atlas({
          projectId,
          action: { type: "read" },
          view: "diagnostics",
        });
        expect(refreshed.documentation.features[0]?.members).toEqual([page.id]);
        expect(refreshed.diagnostics.some((d) => d.code === "missing-reference")).toBe(true);
      }).pipe(Effect.ensuring(harness.dispose));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
