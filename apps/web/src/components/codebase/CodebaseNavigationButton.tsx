import { codebaseNavigation } from "../../lib/codebaseNavigation";
import { Link } from "@tanstack/react-router";
import { NetworkIcon } from "lucide-react";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { Button } from "../ui/button";

export function CodebaseNavigationButton({ compact = false }: { compact?: boolean }) {
  const { activeThread, activeDraftThread, defaultProjectRef } = useHandleNewThread();
  const search = codebaseNavigation({ activeThread, activeDraftThread, defaultProjectRef });
  const pendingWorktree = search === null;
  return (
    <Button
      variant="ghost"
      size={compact ? "icon-sm" : "sm"}
      className={compact ? undefined : "w-full justify-start"}
      disabled={pendingWorktree}
      title={
        pendingWorktree ? "Create the draft worktree before exploring it." : "Explore codebase"
      }
      aria-label="Explore codebase"
      render={pendingWorktree ? undefined : <Link to="/codebase" search={search ?? {}} />}
    >
      <NetworkIcon className="size-4" />
      {!compact && "Codebase"}
    </Button>
  );
}
