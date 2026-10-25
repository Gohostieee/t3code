import { supportsNativeTerminalOutput } from "./nativeTerminalModule";
import { useEnvironmentScope } from "../../state/session";
import { Menu } from "../../components/ui/Menu";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { type StaticScreenProps, useIsFocused, useNavigation } from "@react-navigation/native";
import {
  DEFAULT_TERMINAL_ID,
  EnvironmentId,
  ProjectId,
  AuthTerminalOperateScope,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { AppState, ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { uuidv4 } from "../../lib/uuid";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProject, useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  useAttachedTerminalSession,
  useKnownTerminalSessions,
} from "../../state/use-terminal-session";
import { vcsEnvironment } from "../../state/vcs";
import { cacheSelectedTerminal, getSelectedTerminal } from "./terminalUiState";
import { TerminalSurface } from "./NativeTerminalSurface";

export function ProjectTerminalLauncher() {
  const projects = useProjects();
  const navigation = useNavigation();
  if (projects.length === 0) return null;
  return (
    <View className="px-4 py-2">
      <Menu
        title="Project terminals"
        actions={projects.map((project) => ({
          id: `${project.environmentId}:${project.id}`,
          title: project.title,
          subtitle: project.workspaceRoot,
        }))}
        onPressAction={({ nativeEvent }) => {
          const project = projects.find(
            (entry) => `${entry.environmentId}:${entry.id}` === nativeEvent.event,
          );
          if (project)
            navigation.navigate("ProjectTerminal", {
              environmentId: project.environmentId,
              projectId: project.id,
            });
        }}
      >
        <ControlPill icon="terminal" label="Project terminals" variant="pill" />
      </Menu>
    </View>
  );
}

export function ProjectTerminalRouteScreen({
  route,
}: StaticScreenProps<{ environmentId: string; projectId: string }>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const canOperate = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const projectId = ProjectId.make(route.params.projectId);
  const project = useProject({ environmentId, projectId });
  const focused = useIsFocused();
  const workspaces = useEnvironmentQuery(
    terminalEnvironment.workspaces({
      environmentId,
      input: { projectId, expectedProjectRoot: project?.workspaceRoot },
    }),
  );
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const workspace = workspaceId
    ? workspaces.data?.find((entry) => entry.id === workspaceId)
    : workspaces.data?.find((entry) => entry.worktreePath === null);
  const [showLegacy, setShowLegacy] = useState(false);
  const [legacyId, setLegacyId] = useState<string | undefined>();
  const legacy = useEnvironmentQuery(
    showLegacy
      ? terminalEnvironment.legacyHistory({ environmentId, input: { historyId: legacyId } })
      : null,
  );
  const [terminalId, setTerminalId] = useState(DEFAULT_TERMINAL_ID);
  const { sessions: knownSessions } = useKnownTerminalSessions({
    environmentId,
    workspaceId: workspace?.id ?? null,
  });
  const sessions = knownSessions ?? [];
  const selected = sessions.find((entry) => entry.target.terminalId === terminalId);
  const [openFailure, setOpenFailure] = useState<{ workspaceId: string; message: string } | null>(
    null,
  );
  const [openAttempt, setOpenAttempt] = useState(0);
  const [readyWorkspaceId, setReadyWorkspaceId] = useState<string | null>(null);
  const attachInput = useMemo(
    () =>
      workspace && readyWorkspaceId === workspace.id && focused && !showLegacy
        ? {
            workspaceId: workspace.id,
            terminalId,
            cwd: selected?.state.summary?.cwd ?? workspace.cwd,
            worktreePath: workspace.worktreePath,
          }
        : null,
    [workspace, readyWorkspaceId, focused, showLegacy, terminalId, selected?.state.summary?.cwd],
  );
  const terminal = useAttachedTerminalSession({
    environmentId,
    terminal: attachInput,
    materializeBuffer: !supportsNativeTerminalOutput(),
  });
  const git = useEnvironmentQuery(
    workspace && focused
      ? vcsEnvironment.status({ environmentId, input: { cwd: workspace.cwd } })
      : null,
  );
  const open = useAtomCommand(terminalEnvironment.open, "open project terminal");
  const retainedSession = useEffectEvent((id: string) => {
    const retained = getSelectedTerminal({ environmentId, workspaceId: id });
    return sessions.find(
      (entry) =>
        entry.target.terminalId === retained &&
        (entry.state.status === "running" || entry.state.status === "starting"),
    );
  });
  const resolvedWorkspaceId = workspace?.id;
  const workspaceCwd = workspace?.cwd;
  const worktreePath = workspace?.worktreePath;
  const available = workspace?.available;
  useEffect(() => {
    if (!resolvedWorkspaceId || !workspaceCwd) return;
    setOpenFailure(null);
    if (available === false || !canOperate) {
      setReadyWorkspaceId(resolvedWorkspaceId);
      return;
    }
    const retained = retainedSession(resolvedWorkspaceId);
    if (retained) {
      setTerminalId(retained.target.terminalId);
      setReadyWorkspaceId(resolvedWorkspaceId);
      return;
    }
    let current = true;
    void open({
      environmentId,
      input: {
        workspaceId: resolvedWorkspaceId,
        terminalId: DEFAULT_TERMINAL_ID,
        selectPrimary: true,
        cwd: workspaceCwd,
        worktreePath,
      },
    }).then((result) => {
      if (current && result._tag === "Success") {
        setTerminalId(result.value.terminalId);
        setReadyWorkspaceId(resolvedWorkspaceId);
      } else if (current && result._tag === "Failure") {
        setOpenFailure({
          workspaceId: resolvedWorkspaceId,
          message: String(squashAtomCommandFailure(result)),
        });
      }
    });
    return () => {
      current = false;
    };
  }, [
    resolvedWorkspaceId,
    workspaceCwd,
    worktreePath,
    available,
    canOperate,
    environmentId,
    open,
    openAttempt,
  ]);
  useEffect(() => {
    if (resolvedWorkspaceId && readyWorkspaceId === resolvedWorkspaceId)
      cacheSelectedTerminal({ environmentId, workspaceId: resolvedWorkspaceId, terminalId });
  }, [environmentId, resolvedWorkspaceId, readyWorkspaceId, terminalId]);
  const write = useAtomCommand(terminalEnvironment.write, "terminal write");
  const resize = useAtomCommand(terminalEnvironment.resize, "terminal resize");
  const restart = useAtomCommand(terminalEnvironment.restart, "terminal restart");
  const terminate = useAtomCommand(terminalEnvironment.close, "terminate terminal");
  const running = terminal.status === "running";
  const target =
    workspace && readyWorkspaceId === workspace.id
      ? { workspaceId: workspace.id, terminalId, generation: terminal.summary?.generation }
      : null;
  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions
        options={{ headerShown: true, title: `${project?.title ?? "Project"} terminals` }}
      />
      <View className="flex-row flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
        <Menu
          title="Checkout"
          actions={(workspaces.data ?? []).map((entry) => ({
            id: entry.id,
            title: entry.worktreePath === null ? "Main checkout" : entry.cwd,
            subtitle: entry.cwd,
          }))}
          onPressAction={({ nativeEvent }) => {
            setReadyWorkspaceId(null);
            setWorkspaceId(nativeEvent.event);
            setTerminalId(DEFAULT_TERMINAL_ID);
          }}
        >
          <ControlPill icon="folder" label="Checkout" variant="pill" />
        </Menu>
        <Menu
          title="Sessions"
          actions={sessions.map((entry) => ({
            id: entry.target.terminalId,
            title: entry.state.summary?.label ?? "Terminal",
            subtitle: entry.state.status,
          }))}
          onPressAction={({ nativeEvent }) => setTerminalId(nativeEvent.event)}
        >
          <ControlPill icon="terminal" label="Sessions" variant="pill" />
        </Menu>
        <ControlPill
          icon="clock"
          accessibilityLabel="Saved terminal history"
          onPress={() => setShowLegacy((value) => !value)}
        />
        <ControlPill
          icon="plus"
          accessibilityLabel="New terminal"
          onPress={() => {
            if (!workspace || !canOperate) return;
            void open({
              environmentId,
              input: {
                workspaceId: workspace.id,
                terminalId: uuidv4(),
                cwd: workspace.cwd,
                worktreePath: workspace.worktreePath,
              },
            }).then((result) => {
              if (result._tag === "Success") setTerminalId(result.value.terminalId);
            });
          }}
        />
        {canOperate &&
          (running ? (
            <ControlPill
              icon="stop.fill"
              accessibilityLabel="Terminate shared session"
              onPress={() => {
                if (target) void terminate({ environmentId, input: target });
              }}
            />
          ) : (
            <ControlPill
              icon="arrow.clockwise"
              label="Restart"
              variant="pill"
              onPress={() => {
                if (target && workspace)
                  void restart({
                    environmentId,
                    input: {
                      ...target,
                      cwd: selected?.state.summary?.cwd ?? workspace.cwd,
                      worktreePath: workspace.worktreePath,
                      cols: 80,
                      rows: 24,
                    },
                  });
              }}
            />
          ))}
      </View>
      <Text className="px-3 py-2 text-xs text-foreground-muted">
        {workspace
          ? `Launch: ${selected?.state.summary?.cwd ?? workspace.cwd}${git.data?.isRepo ? ` · ${git.data.refName ?? "Detached HEAD"}` : ""}`
          : (workspaces.error ?? "Resolving checkout...")}
      </Text>
      {openFailure && openFailure.workspaceId === workspace?.id && (
        <View className="p-3">
          <Text>{openFailure.message}</Text>
          <ControlPill
            icon="arrow.clockwise"
            label="Retry opening terminal"
            onPress={() => setOpenAttempt((value) => value + 1)}
          />
        </View>
      )}
      {terminal.error && <Text className="px-3 text-xs text-red-400">{terminal.error}</Text>}
      {showLegacy ? (
        <View className="flex-1 p-3">
          <Text className="text-xs text-foreground-muted">
            Read-only saved transcripts. Legacy entries without checkout metadata remain separate.
          </Text>
          <Menu
            title="Saved history"
            actions={(legacy.data?.histories ?? []).map((entry) => ({
              id: entry.id,
              title: entry.label,
            }))}
            onPressAction={({ nativeEvent }) => setLegacyId(nativeEvent.event)}
          >
            <ControlPill icon="clock" label="Choose transcript" variant="pill" />
          </Menu>
          <ScrollView>
            <Text selectable className="font-mono text-xs">
              {legacy.data?.text ?? legacy.error ?? "Select a transcript."}
            </Text>
          </ScrollView>
        </View>
      ) : (
        target && (
          <TerminalSurface
            terminalKey={`${environmentId}:${target.workspaceId}:${terminalId}`}
            buffer={terminal.buffer}
            output={terminal.version === 0 ? null : terminal.output}
            isRunning={running}
            readOnly={!canOperate}
            style={{ flex: 1 }}
            onInput={(data) => {
              if (canOperate && running && focused)
                void write({ environmentId, input: { ...target, data } });
            }}
            onResize={(size) => {
              if (canOperate && running && focused && AppState.currentState === "active")
                void resize({ environmentId, input: { ...target, ...size } });
            }}
          />
        )
      )}
    </View>
  );
}
