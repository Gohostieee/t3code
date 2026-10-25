import {
  DEFAULT_TERMINAL_ID,
  AuthTerminalOperateScope,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { useStableCallback } from "../../hooks/useStableCallback";
import { randomUUID } from "~/lib/utils";
import { readEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import { useKnownTerminalSessions } from "../../state/terminalSessions";
import { useThreadTerminalWorkspace } from "../../state/terminalWorkspace";
import { useAtomCommand } from "../../state/use-atom-command";

export interface TerminalLaunchLocation {
  readonly cwd: string;
  readonly worktreePath: string | null;
}

export function useThreadTerminalActions(threadRef: ScopedThreadRef | null) {
  const workspace = useThreadTerminalWorkspace(threadRef);
  const workspaceRef = workspace.ref;
  const openTerminalCommand = useAtomCommand(terminalEnvironment.open, "terminal open");
  const runTask = useAtomCommand(terminalEnvironment.runTask, "terminal task");
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal write");
  const closeTerminalCommand = useAtomCommand(terminalEnvironment.close, "terminal close");
  const knownSessions = useKnownTerminalSessions({
    environmentId: workspaceRef?.environmentId ?? null,
    workspaceId: workspaceRef?.workspaceId ?? null,
  });
  const canWrite = () =>
    workspaceRef !== null &&
    readEnvironmentScope(workspaceRef.environmentId, AuthTerminalOperateScope);
  const allocateTerminalId = () => randomUUID();
  const launchTerminal = (input: {
    readonly place: (terminalId: string) => void;
    readonly terminalId?: string;
    readonly selectPrimary?: boolean;
    readonly command?: string;
    readonly location?: TerminalLaunchLocation | null;
    readonly extraEnv?: Record<string, string>;
    readonly size?: { readonly cols: number; readonly rows: number };
  }) => {
    if (!workspaceRef || !workspace.data || !canWrite()) return null;
    const location = input.location ?? workspace.data;
    const terminalId =
      input.terminalId ??
      (input.command !== undefined
        ? `task-${randomUUID()}`
        : input.selectPrimary
          ? DEFAULT_TERMINAL_ID
          : allocateTerminalId());
    const request = {
      workspaceId: workspaceRef.workspaceId,
      terminalId,
      cwd: location.cwd,
      worktreePath: location.worktreePath,
      env: projectScriptRuntimeEnv({
        project: { cwd: workspace.project?.workspaceRoot ?? workspace.data.cwd },
        worktreePath: location.worktreePath,
        ...(input.extraEnv ? { extraEnv: input.extraEnv } : {}),
      }),
      ...input.size,
    };
    // Place only after the explicit open; mounting must never create a second shell.
    const result = (
      input.command !== undefined
        ? runTask({
            environmentId: workspaceRef.environmentId,
            input: { ...request, command: input.command },
          })
        : openTerminalCommand({
            environmentId: workspaceRef.environmentId,
            input: { ...request, ...(input.selectPrimary ? { selectPrimary: true } : {}) },
          })
    ).then((outcome) => {
      if (outcome._tag === "Success") input.place(outcome.value.terminalId);
      return outcome;
    });
    return { terminalId, result };
  };
  const sessionTarget = (terminalId: string) => ({
    workspaceId: workspaceRef!.workspaceId,
    terminalId,
    generation: knownSessions?.find((session) => session.target.terminalId === terminalId)?.state
      .summary?.generation,
  });
  const closeTerminalSession = (terminalId: string) => {
    if (!workspaceRef || !canWrite()) return;
    void closeTerminalCommand({
      environmentId: workspaceRef.environmentId,
      input: sessionTarget(terminalId),
    });
  };
  const writeToTerminal = (terminalId: string, data: string) => {
    if (!workspaceRef || !canWrite()) return null;
    return writeTerminal({
      environmentId: workspaceRef.environmentId,
      input: { ...sessionTarget(terminalId), data },
    });
  };
  return {
    workspaceRef,
    canWrite: useStableCallback(canWrite),
    allocateTerminalId: useStableCallback(allocateTerminalId),
    launchTerminal: useStableCallback(launchTerminal),
    closeTerminalSession: useStableCallback(closeTerminalSession),
    writeToTerminal: useStableCallback(writeToTerminal),
  };
}
