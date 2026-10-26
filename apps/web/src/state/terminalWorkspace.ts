import { type EnvironmentId, type ProjectId, type ScopedThreadRef } from "@t3tools/contracts";
import { selectWorkspaceTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";

import { useComposerDraftStore } from "../composerDraftStore";
import { useThreadShell, useProject } from "./entities";
import { useEnvironmentQuery } from "./query";
import { terminalEnvironment } from "./terminal";

function useTerminalWorkspace(input: {
  environmentId: EnvironmentId | null;
  projectId: ProjectId | null;
  worktreePath: string | null;
  enabled?: boolean;
}) {
  const project = useProject(
    input.environmentId && input.projectId
      ? { environmentId: input.environmentId, projectId: input.projectId }
      : null,
  );
  const query = useEnvironmentQuery(
    input.environmentId && input.projectId && input.enabled !== false
      ? terminalEnvironment.resolveWorkspace({
          environmentId: input.environmentId,
          input: {
            projectId: input.projectId,
            worktreePath: input.worktreePath,
            expectedProjectRoot: project?.workspaceRoot,
          },
        })
      : null,
  );
  const workspace = query.data;
  const ref =
    workspace && input.environmentId
      ? { environmentId: input.environmentId, workspaceId: workspace.id }
      : null;
  return { ...query, ref, project };
}

export function useThreadTerminalWorkspace(threadRef: ScopedThreadRef | null) {
  const thread = useThreadShell(threadRef);
  const draft = useComposerDraftStore((state) =>
    threadRef ? state.getDraftThreadByRef(threadRef) : null,
  );
  const pendingWorktree = !thread && draft?.envMode === "worktree" && !draft.worktreePath;
  return useTerminalWorkspace({
    environmentId: threadRef?.environmentId ?? null,
    projectId: thread?.projectId ?? draft?.projectId ?? null,
    worktreePath: thread ? thread.worktreePath : (draft?.worktreePath ?? null),
    enabled: !pendingWorktree,
  });
}

export function useThreadTerminalUiState(threadRef: ScopedThreadRef | null) {
  const workspace = useThreadTerminalWorkspace(threadRef);
  return useTerminalUiStateStore((state) =>
    selectWorkspaceTerminalUiState(state.terminalUiStateByWorkspaceKey, workspace.ref),
  );
}
