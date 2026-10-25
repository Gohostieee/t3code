import { type EnvironmentId, type ProjectId, type ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { useThreadShell, useProject } from "./entities";
import { useEnvironmentQuery } from "./query";
import { terminalEnvironment } from "./terminal";

export function useTerminalWorkspace(input: {
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
  const ref = useMemo(
    () =>
      workspace && input.environmentId
        ? { environmentId: input.environmentId, workspaceId: workspace.id }
        : null,
    [input.environmentId, workspace],
  );
  return { ...query, ref };
}

export function useThreadTerminalWorkspace(threadRef: ScopedThreadRef | null) {
  const thread = useThreadShell(threadRef);
  return useTerminalWorkspace({
    environmentId: threadRef?.environmentId ?? null,
    projectId: thread?.projectId ?? null,
    worktreePath: thread?.worktreePath ?? null,
  });
}
