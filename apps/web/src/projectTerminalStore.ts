import type { ScopedProjectRef } from "@t3tools/contracts";
import { create } from "zustand";

export const useProjectTerminalStore = create<{
  project: ScopedProjectRef | null;
  workspaceId: string | null;
  open: (project: ScopedProjectRef, workspaceId?: string) => void;
  hide: () => void;
}>((set) => ({
  project: null,
  workspaceId: null,
  open: (project, workspaceId) => set({ project, workspaceId: workspaceId ?? null }),
  hide: () => set({ project: null, workspaceId: null }),
}));

export const openProjectTerminal = (project: ScopedProjectRef, workspaceId?: string) =>
  useProjectTerminalStore.getState().open(project, workspaceId);
