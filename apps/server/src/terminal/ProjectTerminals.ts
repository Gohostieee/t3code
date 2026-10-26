import {
  type ProjectId,
  type TerminalError,
  type TerminalWorkspace,
  TerminalWorkspaceError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ProjectService from "../project/ProjectService.ts";
import * as TerminalManager from "./Manager.ts";

interface ProjectInput {
  readonly projectId: ProjectId;
  readonly expectedProjectRoot?: string | undefined;
}

class ProjectTerminals extends Context.Service<
  ProjectTerminals,
  {
    readonly listWorkspaces: (
      input: ProjectInput,
    ) => Effect.Effect<ReadonlyArray<TerminalWorkspace>, TerminalError>;
    readonly resolveWorkspace: (
      input: ProjectInput & { readonly worktreePath: string | null },
    ) => Effect.Effect<TerminalWorkspace, TerminalError>;
  }
>()("t3/terminal/ProjectTerminals") {}

export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const terminals = yield* TerminalManager.TerminalManager;
  const readProject = Effect.fn("ProjectTerminals.readProject")(function* (input: ProjectInput) {
    const project = yield* projects
      .getById(input.projectId)
      .pipe(
        Effect.mapError(
          () => new TerminalWorkspaceError({ message: "Unable to read the terminal's project." }),
        ),
      );
    if (Option.isNone(project))
      return yield* new TerminalWorkspaceError({ message: "The project has been removed." });
    if (
      input.expectedProjectRoot !== undefined &&
      input.expectedProjectRoot !== project.value.workspaceRoot
    )
      return yield* new TerminalWorkspaceError({
        message: "The project root changed. Refresh before opening its terminals.",
      });
    return { projectId: project.value.id, cwd: project.value.workspaceRoot };
  });
  return ProjectTerminals.of({
    listWorkspaces: Effect.fn("ProjectTerminals.listWorkspaces")(function* (input) {
      return yield* terminals.listWorkspaces(yield* readProject(input));
    }),
    resolveWorkspace: Effect.fn("ProjectTerminals.resolveWorkspace")(function* (input) {
      return yield* terminals.resolveWorkspace({
        ...(yield* readProject(input)),
        worktreePath: input.worktreePath,
      });
    }),
  });
});
