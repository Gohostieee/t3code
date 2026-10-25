import { useEnvironmentScope } from "../state/session";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_TERMINAL_ID,
  AuthTerminalOperateScope,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";
import { resolveShortcutCommand } from "../keybindings";
import { selectWorkspaceTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";

import { randomUUID } from "../lib/utils";
import { useProjectTerminalStore } from "../projectTerminalStore";
import { useProject } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { primaryServerKeybindingsAtom } from "../state/server";
import { terminalEnvironment } from "../state/terminal";
import { useKnownTerminalSessions } from "../state/terminalSessions";
import { useAtomCommand } from "../state/use-atom-command";
import { TerminalViewport } from "./ThreadTerminalDrawer";
import { Button } from "./ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "./ui/dialog";

function ProjectTerminals({ projectRef }: { projectRef: ScopedProjectRef }) {
  const project = useProject(projectRef);
  const canOperate = useEnvironmentScope(projectRef.environmentId, AuthTerminalOperateScope);
  const query = useEnvironmentQuery(
    terminalEnvironment.workspaces({
      environmentId: projectRef.environmentId,
      input: { projectId: projectRef.projectId, expectedProjectRoot: project?.workspaceRoot },
    }),
  );
  const selectedWorkspaceId = useProjectTerminalStore((state) => state.workspaceId);
  const setSelectedWorkspaceId = (workspaceId: string) =>
    useProjectTerminalStore.setState({ workspaceId });
  const [showLegacy, setShowLegacy] = useState(false);
  const [legacyId, setLegacyId] = useState<string | undefined>();
  const legacy = useEnvironmentQuery(
    showLegacy
      ? terminalEnvironment.legacyHistory({
          environmentId: projectRef.environmentId,
          input: { historyId: legacyId },
        })
      : null,
  );
  const workspace =
    selectedWorkspaceId === null
      ? query.data?.find((entry) => entry.worktreePath === null)
      : query.data?.find((entry) => entry.id === selectedWorkspaceId);
  const workspaceRef = workspace
    ? { environmentId: projectRef.environmentId, workspaceId: workspace.id }
    : null;
  const uiState = useTerminalUiStateStore((state) =>
    selectWorkspaceTerminalUiState(state.terminalUiStateByWorkspaceKey, workspaceRef),
  );
  const terminalId = uiState.activeTerminalId || DEFAULT_TERMINAL_ID;
  const setTerminalId = (id: string) => {
    if (!workspaceRef) return;
    useTerminalUiStateStore.getState().ensureTerminal(workspaceRef, id, { open: true });
    useTerminalUiStateStore.getState().setActiveTerminal(workspaceRef, id);
  };
  const sessions =
    useKnownTerminalSessions({
      environmentId: projectRef.environmentId,
      workspaceId: workspace?.id ?? null,
    }) ?? [];
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const terminate = useAtomCommand(terminalEnvironment.close, "terminate terminal");
  const clear = useAtomCommand(terminalEnvironment.clear, "clear terminal output");
  const hide = useProjectTerminalStore((state) => state.hide);
  const selectedSession = sessions.find((session) => session.target.terminalId === terminalId);
  const open = useAtomCommand(terminalEnvironment.open, "open project terminal");
  const [openFailure, setOpenFailure] = useState<{ workspaceId: string; message: string } | null>(
    null,
  );
  const [openAttempt, setOpenAttempt] = useState(0);
  const [readyWorkspaceId, setReadyWorkspaceId] = useState<string | null>(null);
  const retainRunningSelection = useEffectEvent(
    () =>
      uiState.activeTerminalId &&
      (selectedSession?.state.status === "running" || selectedSession?.state.status === "starting"),
  );
  const workspaceId = workspace?.id;
  const workspaceCwd = workspace?.cwd;
  const worktreePath = workspace?.worktreePath;
  const available = workspace?.available;
  useEffect(() => {
    if (!workspaceId || !workspaceCwd) return;
    const attempt = openAttempt;
    if (available === false || !canOperate || retainRunningSelection()) {
      return;
    }
    let current = true;
    const target = { environmentId: projectRef.environmentId, workspaceId };
    void open({
      environmentId: projectRef.environmentId,
      input: {
        workspaceId,
        terminalId: DEFAULT_TERMINAL_ID,
        selectPrimary: true,
        cwd: workspaceCwd,
        worktreePath,
      },
    }).then((result) => {
      if (!current || attempt !== openAttempt) return;
      if (result._tag === "Success") {
        useTerminalUiStateStore
          .getState()
          .ensureTerminal(target, result.value.terminalId, { open: true });
        useTerminalUiStateStore.getState().setActiveTerminal(target, result.value.terminalId);
        setReadyWorkspaceId(workspaceId);
      } else {
        setOpenFailure({ workspaceId, message: String(squashAtomCommandFailure(result)) });
      }
    });
    return () => {
      current = false;
    };
  }, [
    workspaceId,
    workspaceCwd,
    worktreePath,
    available,
    canOperate,
    open,
    projectRef.environmentId,
    openAttempt,
  ]);

  const newTerminal = () => {
    if (!workspace || !canOperate) return;
    void open({
      environmentId: projectRef.environmentId,
      input: {
        workspaceId: workspace.id,
        terminalId: randomUUID(),
        cwd: workspace.cwd,
        worktreePath: workspace.worktreePath,
      },
    }).then((result) => {
      if (result._tag === "Success") setTerminalId(result.value.terminalId);
    });
  };
  const handleNewTerminal = useEffectEvent(newTerminal);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: true, terminalOpen: true },
      });
      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        hide();
      }
      if (command === "terminal.new" && workspaceRef) {
        event.preventDefault();
        event.stopPropagation();
        handleNewTerminal();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [keybindings, hide, workspaceRef]);
  return (
    <>
      <DialogHeader>
        <DialogTitle>{project?.title ?? "Project"} terminals</DialogTitle>
        <DialogDescription>
          Shared across chats in this checkout. Clear, restart, and terminate affect every attached
          client. Hiding this view leaves sessions running.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-center gap-2 border-y px-4 py-2">
        <label className="min-w-0 flex-1 text-xs">
          Checkout
          <select
            aria-label="Terminal checkout"
            className="ml-2 max-w-full rounded border bg-background p-1"
            value={workspace?.id ?? ""}
            onChange={(event) => {
              setReadyWorkspaceId(null);
              setSelectedWorkspaceId(event.target.value);
            }}
          >
            {query.data?.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.cwd}
                {entry.available === false ? " (unavailable)" : ""}
              </option>
            ))}
          </select>
        </label>
        <select
          aria-label="Terminal session"
          className="rounded border bg-background p-1 text-xs"
          value={terminalId}
          onChange={(event) => setTerminalId(event.target.value)}
        >
          {!sessions.some((session) => session.target.terminalId === terminalId) && (
            <option value={terminalId}>Default terminal</option>
          )}
          {sessions.map((session) => (
            <option key={session.target.terminalId} value={session.target.terminalId}>
              {session.state.summary?.label ?? session.target.terminalId} · {session.state.status}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" disabled={!canOperate} onClick={newTerminal}>
          New terminal
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!workspace || !canOperate}
          onClick={() => {
            if (workspace)
              void clear({
                environmentId: projectRef.environmentId,
                input: {
                  workspaceId: workspace.id,
                  terminalId,
                  generation: selectedSession?.state.summary?.generation,
                },
              });
          }}
        >
          Clear output
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!workspace || !canOperate}
          onClick={() => {
            if (workspace)
              void terminate({
                environmentId: projectRef.environmentId,
                input: {
                  workspaceId: workspace.id,
                  terminalId,
                  generation: selectedSession?.state.summary?.generation,
                },
              });
          }}
        >
          Terminate session
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setShowLegacy((value) => !value)}>
          {showLegacy ? "Live terminals" : "Saved history"}
        </Button>
        <Button size="sm" variant="ghost" onClick={hide}>
          Return to chat
        </Button>
      </div>
      <div className="min-h-0 flex-1 p-2">
        {showLegacy ? (
          <div className="flex h-full flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              Read-only saved transcripts for this environment. Legacy transcripts without recorded
              checkout metadata remain separate.
            </p>
            <select
              aria-label="Saved terminal history"
              value={legacyId ?? ""}
              onChange={(event) => setLegacyId(event.target.value || undefined)}
            >
              <option value="">Choose a transcript</option>
              {legacy.data?.histories.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-2 text-xs">
              {legacy.data?.text ?? legacy.error ?? "Select a saved transcript."}
            </pre>
          </div>
        ) : openFailure && openFailure.workspaceId === workspace?.id ? (
          <div role="alert" className="p-4 text-sm">
            <p>{openFailure?.message}</p>
            <Button
              onClick={() => {
                setOpenFailure(null);
                setOpenAttempt((value) => value + 1);
              }}
            >
              Retry opening terminal
            </Button>
          </div>
        ) : workspace &&
          (readyWorkspaceId === workspace.id ||
            available === false ||
            !canOperate ||
            selectedSession !== undefined) ? (
          <TerminalViewport
            key={`${workspace.id}:${terminalId}`}
            workspaceRef={{ environmentId: projectRef.environmentId, workspaceId: workspace.id }}
            advancedTypography={false}
            visible
            terminalId={terminalId}
            terminalLabel={selectedSession?.state.summary?.label ?? "Terminal"}
            cwd={selectedSession?.state.summary?.cwd ?? workspace.cwd}
            worktreePath={workspace.worktreePath}
            onSessionExited={() => {}}
            focusRequestId={0}
            autoFocus
            resizeEpoch={0}
            drawerHeight={500}
            keybindings={keybindings}
          />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">
            {query.error ?? "Resolving project checkouts..."}
          </p>
        )}
      </div>
    </>
  );
}

export function ProjectTerminalDialog() {
  const project = useProjectTerminalStore((state) => state.project);
  const hide = useProjectTerminalStore((state) => state.hide);
  return (
    <Dialog
      open={project !== null}
      onOpenChange={(open) => {
        if (!open) hide();
      }}
    >
      <DialogPopup className="flex h-[80dvh] max-w-6xl flex-col overflow-hidden">
        {project && (
          <ProjectTerminals
            key={`${project.environmentId}:${project.projectId}`}
            projectRef={project}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}
