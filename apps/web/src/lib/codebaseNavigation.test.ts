import { expect, it } from "vite-plus/test";
import { codebaseNavigation } from "./codebaseNavigation";
it("opens the active checkout consistently and never substitutes main for an unbuilt worktree", () => {
  const project = { environmentId: "remote", projectId: "project" };
  expect(
    codebaseNavigation({
      activeDraftThread: { ...project, envMode: "worktree", worktreePath: null },
    }),
  ).toBeNull();
  expect(
    codebaseNavigation({
      activeDraftThread: { ...project, envMode: "worktree", worktreePath: "/worktree" },
    }),
  ).toEqual({ environment: "remote", project: "project", checkout: "/worktree" });
  expect(codebaseNavigation({ activeThread: { ...project, id: "thread" } })).toEqual({
    environment: "remote",
    project: "project",
    thread: "thread",
  });
  expect(codebaseNavigation({ defaultProjectRef: project })).toEqual({
    environment: "remote",
    project: "project",
  });
});
