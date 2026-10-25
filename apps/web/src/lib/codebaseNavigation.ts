/** All explorer entry points resolve drafts and durable threads the same way. */
export function codebaseNavigation(context: {
  activeThread?: { environmentId: string; projectId: string; id: string } | null;
  activeDraftThread?: {
    environmentId: string;
    projectId: string;
    envMode: string;
    worktreePath?: string | null;
  } | null;
  defaultProjectRef?: { environmentId: string; projectId: string } | null;
}) {
  const { activeThread: thread, activeDraftThread: draft, defaultProjectRef: project } = context;
  if (thread)
    return { environment: thread.environmentId, project: thread.projectId, thread: thread.id };
  if (draft)
    return draft.envMode === "worktree" && !draft.worktreePath
      ? null
      : {
          environment: draft.environmentId,
          project: draft.projectId,
          ...(draft.worktreePath ? { checkout: draft.worktreePath } : {}),
        };
  return project ? { environment: project.environmentId, project: project.projectId } : {};
}
