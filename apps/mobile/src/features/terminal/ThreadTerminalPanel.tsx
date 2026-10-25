import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { DEFAULT_TERMINAL_ID, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { SymbolView } from "../../components/AppSymbol";
import { memo, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { AppState, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useThreadTerminalWorkspace } from "../../state/terminalWorkspace";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  useAttachedTerminalSession,
  useKnownTerminalSessions,
} from "../../state/use-terminal-session";
import { cacheSelectedTerminal, getSelectedTerminal } from "./terminalUiState";
import { TerminalSurface } from "./NativeTerminalSurface";
import {
  buildThreadTerminalAttachInput,
  type TerminalGridSize,
  type ThreadTerminalSubscriptionIdentity,
} from "./threadTerminalPanelModel";

interface ThreadTerminalPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly visible: boolean;
  readonly onClose: () => void;
}

const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;

export const ThreadTerminalPanel = memo(function ThreadTerminalPanel(
  props: ThreadTerminalPanelProps,
) {
  const workspace = useThreadTerminalWorkspace({
    environmentId: props.environmentId,
    threadId: props.threadId,
  });
  const workspaceId = workspace.data?.id;
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const resizeTerminal = useAtomCommand(terminalEnvironment.resize, "terminal resize");
  const openTerminal = useAtomCommand(terminalEnvironment.open, "open shared terminal");
  const [openFailure, setOpenFailure] = useState<string | null>(null);
  const [openAttempt, setOpenAttempt] = useState(0);
  const [selected, setSelected] = useState<{ workspaceId: string; terminalId: string } | null>(
    null,
  );
  const terminalId =
    selected && selected.workspaceId === workspaceId ? selected.terminalId : DEFAULT_TERMINAL_ID;
  const knownSessions = useKnownTerminalSessions({
    environmentId: props.environmentId,
    workspaceId,
  });
  const retainedSession = useEffectEvent((workspaceId: string) => {
    const retained = getSelectedTerminal({ environmentId: props.environmentId, workspaceId });
    return knownSessions.find(
      (session) =>
        session.target.terminalId === retained &&
        (session.state.status === "running" || session.state.status === "starting"),
    );
  });
  const cwd = workspace.data?.cwd;
  const worktreePath = workspace.data?.worktreePath;
  useEffect(() => {
    if (!props.visible || !workspaceId || !cwd) return;
    setOpenFailure(null);
    const retained = retainedSession(workspaceId);
    if (retained) {
      setSelected({ workspaceId, terminalId: retained.target.terminalId });
      return;
    }
    let current = true;
    void openTerminal({
      environmentId: props.environmentId,
      input: {
        workspaceId,
        terminalId: DEFAULT_TERMINAL_ID,
        selectPrimary: true,
        cwd,
        worktreePath,
      },
    }).then((result) => {
      if (current && result._tag === "Failure")
        setOpenFailure(String(squashAtomCommandFailure(result)));
      if (current && result._tag === "Success") {
        setSelected({ workspaceId, terminalId: result.value.terminalId });
        cacheSelectedTerminal({
          environmentId: props.environmentId,
          workspaceId,
          terminalId: result.value.terminalId,
        });
      }
    });
    return () => {
      current = false;
    };
  }, [
    props.visible,
    props.environmentId,
    workspaceId,
    cwd,
    worktreePath,
    openTerminal,
    openAttempt,
  ]);
  const lastGridSizeRef = useRef<TerminalGridSize>({
    cols: DEFAULT_TERMINAL_COLS,
    rows: DEFAULT_TERMINAL_ROWS,
  });
  const subscriptionIdentity = useMemo<ThreadTerminalSubscriptionIdentity | null>(
    () =>
      workspaceId && selected?.workspaceId === workspaceId
        ? {
            environmentId: props.environmentId,
            workspaceId,
            terminalId,
            cwd: props.cwd,
            worktreePath: props.worktreePath,
          }
        : null,
    [
      props.cwd,
      props.environmentId,
      workspaceId,
      props.worktreePath,
      terminalId,
      selected?.workspaceId,
    ],
  );
  const attachInput = useMemo(
    () =>
      props.visible && subscriptionIdentity
        ? buildThreadTerminalAttachInput(subscriptionIdentity, lastGridSizeRef.current)
        : null,
    [props.visible, subscriptionIdentity],
  );
  const terminal = useAttachedTerminalSession({
    environmentId: props.environmentId,
    terminal: attachInput,
  });

  const terminalKey = `${props.environmentId}:${workspaceId}:${terminalId}`;
  const isRunning = terminal.status === "running" || terminal.status === "starting";

  const sendResize = useCallback(
    (size: TerminalGridSize) => {
      if (!workspaceId || !props.visible || AppState.currentState !== "active") return;
      void resizeTerminal({
        environmentId: props.environmentId,
        input: {
          workspaceId,
          generation: terminal.summary?.generation,
          terminalId,
          cols: size.cols,
          rows: size.rows,
        },
      });
    },
    [
      props.environmentId,
      workspaceId,
      props.visible,
      resizeTerminal,
      terminalId,
      terminal.summary?.generation,
    ],
  );

  useEffect(() => {
    if (isRunning) {
      sendResize(lastGridSizeRef.current);
    }
  }, [isRunning, workspaceId, sendResize]);

  const handleInput = useCallback(
    (data: string) => {
      if (!isRunning || !workspaceId) {
        return;
      }

      void writeTerminal({
        environmentId: props.environmentId,
        input: {
          workspaceId,
          generation: terminal.summary?.generation,
          terminalId,
          data,
        },
      });
    },
    [
      isRunning,
      props.environmentId,
      workspaceId,
      terminalId,
      writeTerminal,
      terminal.summary?.generation,
    ],
  );

  const handleResize = useCallback(
    (size: TerminalGridSize) => {
      const previousSize = lastGridSizeRef.current;
      if (size.cols === previousSize.cols && size.rows === previousSize.rows) {
        return;
      }

      lastGridSizeRef.current = size;
      if (!isRunning || !workspaceId) {
        return;
      }

      sendResize(size);
    },
    [isRunning, workspaceId, sendResize],
  );

  if (!props.visible) {
    return null;
  }

  return (
    <View className="absolute inset-x-3 bottom-28 top-28 overflow-hidden rounded-[8px] border border-white/10 bg-neutral-950 shadow-2xl">
      <View className="flex-row items-center justify-between border-b border-white/10 px-3 py-2">
        <View className="min-w-0 flex-1">
          <Text className="font-t3-bold text-sm text-neutral-100" numberOfLines={1}>
            Terminal
          </Text>
          <Text className="text-2xs text-neutral-500" numberOfLines={1}>
            {workspace.data?.cwd ?? workspace.error ?? "Resolving checkout..."}
          </Text>
        </View>
        <View className="flex-row items-center gap-2">
          {terminal.error ? (
            <Text className="max-w-44 text-right text-2xs text-red-300" numberOfLines={1}>
              {terminal.error}
            </Text>
          ) : null}
          <Pressable
            className="h-8 w-8 items-center justify-center rounded-[8px] bg-white/10"
            onPress={props.onClose}
          >
            <SymbolView name="xmark" size={13} tintColor="#e5e5e5" type="monochrome" />
          </Pressable>
        </View>
      </View>
      {openFailure && (
        <View className="p-3">
          <Text>{openFailure}</Text>
          <Pressable onPress={() => setOpenAttempt((value) => value + 1)}>
            <Text>Retry opening terminal</Text>
          </Pressable>
        </View>
      )}
      <TerminalSurface
        terminalKey={terminalKey}
        buffer={terminal.buffer}
        isRunning={isRunning}
        onInput={handleInput}
        onResize={handleResize}
        style={{ flex: 1 }}
      />
    </View>
  );
});
