import type { ScopedTerminalWorkspaceRef } from "@t3tools/contracts";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";

export function revealThreadTerminal(
  threadRef: ScopedThreadRef,
  terminalId: string,
  workspaceRef: ScopedTerminalWorkspaceRef,
) {
  const panels = useRightPanelStore.getState();
  const surface = selectThreadRightPanelState(panels.byThreadKey, threadRef).surfaces.find(
    (surface) =>
      surface.kind === "terminal" &&
      surface.workspaceId === workspaceRef.workspaceId &&
      surface.terminalIds.includes(terminalId),
  );
  if (surface) {
    panels.activateTerminal(threadRef, surface.id, terminalId);
    panels.activateSurface(threadRef, surface.id);
    return;
  }
  useTerminalUiStateStore.getState().ensureTerminal(workspaceRef, terminalId, {
    open: true,
    active: true,
  });
}
