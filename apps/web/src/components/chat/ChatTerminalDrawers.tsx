import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  parseScopedThreadKey,
  scopedTerminalWorkspaceKey,
} from "@t3tools/client-runtime/environment";
import { useState } from "react";
import type { TerminalContextSelection } from "../../lib/terminalContext";
import { usePanelAnimationSettings, usePanelPresence } from "../../panelAnimations";
import { useThreadTerminalWorkspace } from "../../state/terminalWorkspace";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  reconcileMountedTerminalThreadIds,
} from "../ChatView.logic";
import {
  PersistentThreadTerminalDrawer,
  type PersistentTerminalLaunchContext,
} from "../PersistentThreadTerminals";

interface ChatTerminalDrawersProps {
  readonly activeThreadKey: string | null;
  readonly activeTerminalOpen: boolean;
  readonly composerHeight: number;
  readonly launchContext: PersistentTerminalLaunchContext | null;
  readonly focusRequestId: number;
  readonly splitShortcutLabel: string | undefined;
  readonly splitVerticalShortcutLabel: string | undefined;
  readonly newShortcutLabel: string | undefined;
  readonly closeShortcutLabel: string | undefined;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

/**
 * Keeps terminal drawers mounted for recently open threads, so switching back
 * to one finds its sessions as they were. Every thread's terminal and draft
 * state feeds the reconcile, so it subscribes here instead of in ChatView.
 */
export function ChatTerminalDrawers(props: ChatTerminalDrawersProps) {
  const { activeThreadKey } = props;
  const activeThreadRef = activeThreadKey ? parseScopedThreadKey(activeThreadKey) : null;
  const activeWorkspace = useThreadTerminalWorkspace(activeThreadRef);
  const activeWorkspaceKey = activeWorkspace.ref
    ? scopedTerminalWorkspaceKey(activeWorkspace.ref)
    : null;
  const openTerminalWorkspaces = useTerminalUiStateStore(
    (state) => state.terminalUiStateByWorkspaceKey,
  );
  const [threadRefsByWorkspace, setThreadRefsByWorkspace] = useState<
    Record<string, NonNullable<typeof activeThreadRef>>
  >({});
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  const activeTerminalDrawerPresence = usePanelPresence(
    Boolean(activeWorkspaceKey && props.activeTerminalOpen),
    true,
    panelAnimationsActive,
    activeWorkspaceKey,
    panelAnimationDurationMs,
  );
  const [mountedTerminalThreadKeys, setMountedTerminalThreadKeys] = useState<string[]>([]);
  const existingOpenTerminalThreadKeys = Object.keys(threadRefsByWorkspace).filter(
    (key) => openTerminalWorkspaces[key]?.terminalOpen,
  );
  const reconciledMountedTerminalThreadKeys = reconcileMountedTerminalThreadIds({
    currentThreadIds: mountedTerminalThreadKeys,
    openThreadIds: existingOpenTerminalThreadKeys,
    activeThreadId: activeWorkspaceKey,
    activeThreadTerminalOpen: activeTerminalDrawerPresence.present,
    maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  });
  if (
    reconciledMountedTerminalThreadKeys.length !== mountedTerminalThreadKeys.length ||
    reconciledMountedTerminalThreadKeys.some(
      (threadKey, index) => threadKey !== mountedTerminalThreadKeys[index],
    )
  ) {
    setMountedTerminalThreadKeys(reconciledMountedTerminalThreadKeys);
  }
  const nextThreadRefs = Object.fromEntries(
    reconciledMountedTerminalThreadKeys.flatMap((key) => {
      const ref = key === activeWorkspaceKey ? activeThreadRef : threadRefsByWorkspace[key];
      return ref ? [[key, ref]] : [];
    }),
  );
  if (
    Object.keys(nextThreadRefs).length !== Object.keys(threadRefsByWorkspace).length ||
    Object.entries(nextThreadRefs).some(
      ([key, ref]) =>
        ref.threadId !== threadRefsByWorkspace[key]?.threadId ||
        ref.environmentId !== threadRefsByWorkspace[key]?.environmentId,
    )
  )
    setThreadRefsByWorkspace(nextThreadRefs);
  const mountedTerminalThreadRefs = mountedTerminalThreadKeys.flatMap((mountedThreadKey) => {
    const mountedThreadRef =
      mountedThreadKey === activeWorkspaceKey
        ? activeThreadRef
        : threadRefsByWorkspace[mountedThreadKey];
    return mountedThreadRef ? [{ key: mountedThreadKey, threadRef: mountedThreadRef }] : [];
  });

  return mountedTerminalThreadRefs.map(({ key: mountedThreadKey, threadRef: mountedThreadRef }) => (
    <PersistentThreadTerminalDrawer
      key={mountedThreadKey}
      threadRef={mountedThreadRef}
      threadId={mountedThreadRef.threadId}
      active={mountedThreadKey === activeWorkspaceKey}
      composerHeight={mountedThreadKey === activeWorkspaceKey ? props.composerHeight : 0}
      launchContext={mountedThreadKey === activeWorkspaceKey ? props.launchContext : null}
      focusRequestId={mountedThreadKey === activeWorkspaceKey ? props.focusRequestId : 0}
      splitShortcutLabel={props.splitShortcutLabel}
      splitVerticalShortcutLabel={props.splitVerticalShortcutLabel}
      newShortcutLabel={props.newShortcutLabel}
      closeShortcutLabel={props.closeShortcutLabel}
      keybindings={props.keybindings}
      onAddTerminalContext={props.onAddTerminalContext}
    />
  ));
}
