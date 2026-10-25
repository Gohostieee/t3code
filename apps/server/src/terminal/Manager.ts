/**
 * TerminalManager - Terminal session orchestration service interface.
 *
 * Owns terminal lifecycle operations, output fanout, and session state
 * transitions for workspace-scoped terminals.
 *
 * @module TerminalManager
 */
import {
  DEFAULT_TERMINAL_ID,
  MAX_RETAINED_TERMINAL_SUMMARIES,
  TerminalWorkspace,
  type TerminalRemovalSession,
  type ProjectId,
  type TerminalLegacyHistoryResult,
  TerminalWorkspaceError,
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalWriteError,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalClearInput,
  type TerminalCloseInput,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
  type TerminalTaskInput,
  type TerminalResizeInput,
  type TerminalRestartInput,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
  TerminalSummary,
  type TerminalWriteInput,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ServerConfig from "../config.ts";
import {
  increment,
  terminalRestartsTotal,
  terminalSessionsTotal,
} from "../observability/Metrics.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

export {
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalWriteError,
};

const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
const DEFAULT_PERSIST_DEBOUNCE_MS = 40;
const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;
const DEFAULT_OPEN_COLS = 120;
const DEFAULT_OPEN_ROWS = 30;
const TERMINAL_ENV_BLOCKLIST = new Set(["PORT", "ELECTRON_RENDERER_PORT", "ELECTRON_RUN_AS_NODE"]);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const MAX_TERMINAL_LABEL_LENGTH = 128;

class TerminalSubprocessCheckError extends Schema.TaggedErrorClass<TerminalSubprocessCheckError>()(
  "TerminalSubprocessCheckError",
  {
    cause: Schema.optional(Schema.Defect()),
    terminalPid: Schema.Number,
    command: Schema.Literals(["powershell", "pgrep", "ps"]),
  },
) {
  override get message(): string {
    return `Failed to inspect terminal subprocesses for PID ${this.terminalPid} with ${this.command}`;
  }
}

class TerminalProcessSignalError extends Schema.TaggedErrorClass<TerminalProcessSignalError>()(
  "TerminalProcessSignalError",
  {
    cause: Schema.optional(Schema.Defect()),
    signal: Schema.Literals(["SIGTERM", "SIGKILL"]),
    terminalPid: Schema.Number,
  },
) {
  override get message(): string {
    return `Failed to send ${this.signal} to terminal process ${this.terminalPid}`;
  }
}

/**
 * TerminalManager - Service tag for terminal session orchestration.
 */
export class TerminalManager extends Context.Service<
  TerminalManager,
  {
    readonly legacyHistory: (
      historyId?: string,
    ) => Effect.Effect<TerminalLegacyHistoryResult, TerminalError>;
    readonly closeProject: (projectId: ProjectId) => Effect.Effect<void, TerminalError>;
    readonly withCheckoutRemoval: <A, E, R>(
      cwd: string,
      operation: Effect.Effect<A, E, R>,
      confirmedSessions?: ReadonlyArray<TerminalRemovalSession>,
    ) => Effect.Effect<A, E | TerminalError, R>;
    readonly validateWorkspace: (
      workspaceId: string,
      cwd?: string,
    ) => Effect.Effect<void, TerminalError>;
    readonly listWorkspaces: (input: {
      projectId: ProjectId;
      cwd: string;
    }) => Effect.Effect<ReadonlyArray<TerminalWorkspace>, TerminalError>;
    readonly resolveWorkspace: (
      input: Omit<TerminalWorkspace, "id">,
    ) => Effect.Effect<TerminalWorkspace, TerminalError>;
    /**
     * Open or attach to a terminal session.
     *
     * Reuses an existing session for the same workspace/terminal id and restores
     * persisted history on first open.
     */
    readonly runTask: (
      input: TerminalTaskInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;
    readonly open: (
      input: TerminalOpenInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

    /**
     * Attach to a terminal and stream its initial snapshot followed by live events.
     *
     * Returns an unsubscribe function.
     */
    readonly attachStream: (
      input: TerminalAttachInput,
      listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void, TerminalError>;

    /**
     * Write input bytes to a terminal session.
     */
    readonly write: (input: TerminalWriteInput) => Effect.Effect<void, TerminalError>;

    /**
     * Resize the PTY backing a terminal session.
     */
    readonly resize: (input: TerminalResizeInput) => Effect.Effect<void, TerminalError>;

    /**
     * Clear terminal output history.
     */
    readonly clear: (input: TerminalClearInput) => Effect.Effect<void, TerminalError>;

    /**
     * Restart a terminal session in place.
     *
     * Always resets history before spawning the new process.
     */
    readonly restart: (
      input: TerminalRestartInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

    /**
     * Close an active terminal session.
     *
     * When `terminalId` is omitted, closes all sessions for the workspace.
     */
    readonly close: (input: TerminalCloseInput) => Effect.Effect<void, TerminalError>;

    /**
     * Subscribe to terminal runtime events with a direct callback.
     *
     * Returns an unsubscribe function.
     */
    readonly subscribe: (
      listener: (event: TerminalEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;

    /**
     * Subscribe to lightweight terminal metadata with an initial full snapshot.
     *
     * Returns an unsubscribe function.
     */
    readonly subscribeMetadata: (
      listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;
  }
>()("t3/terminal/Manager/TerminalManager") {}

interface TerminalSubprocessInspectResult {
  readonly hasRunningSubprocess: boolean;
  readonly childCommand: string | null;
  readonly processIds: ReadonlyArray<number>;
}

interface TerminalSubprocessInspector {
  (
    terminalPid: number,
  ): Effect.Effect<TerminalSubprocessInspectResult, TerminalSubprocessCheckError>;
}

const resizePtyProcess = (
  session: TerminalSessionState,
  process: PtyAdapter.PtyProcess,
  cols: number,
  rows: number,
) =>
  Effect.try({
    try: () => process.resize(cols, rows),
    catch: (cause) =>
      new TerminalResizeError({
        workspaceId: session.workspaceId,
        terminalId: session.terminalId,
        terminalPid: process.pid,
        cols,
        rows,
        cause,
      }),
  });

export interface ShellCandidate {
  shell: string;
  args?: string[];
}

export interface TerminalStartInput extends TerminalOpenInput {
  cols: number;
  rows: number;
}

export interface TerminalSessionState {
  primary?: boolean | undefined;
  taskStatus?: "unknown" | "submitted" | undefined;
  generation: string;
  workspaceId: string;
  terminalId: string;
  cwd: string;
  worktreePath: string | null;
  status: TerminalSessionStatus;
  pid: number | null;
  history: string;
  pendingHistoryControlSequence: string;
  pendingProcessEvents: Array<PendingProcessEvent>;
  pendingProcessEventIndex: number;
  processEventDrainRunning: boolean;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  eventSequence: number;
  cols: number;
  rows: number;
  process: PtyAdapter.PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  /** Normalized child command name when `hasRunningSubprocess`; cleared when idle. */
  childCommandLabel: string | null;
  runtimeEnv: Record<string, string> | null;
}

interface PersistHistoryRequest {
  history: string;
  immediate: boolean;
}

type PendingProcessEvent =
  | { type: "output"; data: string }
  | { type: "exit"; event: PtyAdapter.PtyExitEvent };

type DrainProcessEventAction =
  | { type: "idle" }
  | {
      type: "output";
      workspaceId: string;
      terminalId: string;
      sequence: number;
      history: string | null;
      data: string;
    }
  | {
      type: "exit";
      process: PtyAdapter.PtyProcess | null;
      workspaceId: string;
      terminalId: string;
      sequence: number;
      exitCode: number | null;
      exitSignal: number | null;
    };

interface TerminalManagerState {
  sessions: Map<string, TerminalSessionState>;
  killFibers: Map<PtyAdapter.PtyProcess, Fiber.Fiber<void, never>>;
}

function truncateTerminalWireLabel(value: string): string {
  if (value.length <= MAX_TERMINAL_LABEL_LENGTH) return value;
  return value.slice(0, MAX_TERMINAL_LABEL_LENGTH);
}

function normalizeChildCommandName(raw: string, platform: NodeJS.Platform): string | null {
  let trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("(") && trimmed.endsWith(")"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  const firstToken = (trimmed.split(/\s+/)[0] ?? trimmed).trim();
  if (firstToken.length === 0) return null;
  const separators = platform === "win32" ? /[\\/]/ : /\//;
  const base = firstToken.split(separators).at(-1) ?? firstToken;
  const withoutExe =
    platform === "win32" && base.toLowerCase().endsWith(".exe") ? base.slice(0, -4) : base;
  return withoutExe.length > 0 ? withoutExe : null;
}

function terminalWireLabel(session: TerminalSessionState): string {
  if (session.hasRunningSubprocess && session.childCommandLabel) {
    const trimmed = session.childCommandLabel.trim();
    if (trimmed.length > 0) {
      return truncateTerminalWireLabel(trimmed);
    }
  }
  return truncateTerminalWireLabel(getTerminalLabel(session.terminalId));
}

function snapshot(session: TerminalSessionState): TerminalSessionSnapshot {
  return {
    kind:
      session.terminalId.startsWith("task-") || session.terminalId.startsWith("setup-")
        ? "task"
        : "interactive",
    primary: session.primary ?? session.terminalId === DEFAULT_TERMINAL_ID,
    generation: session.generation,
    taskStatus: session.taskStatus,
    workspaceId: session.workspaceId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    history: session.history,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    label: terminalWireLabel(session),
    updatedAt: session.updatedAt,
    sequence: session.eventSequence,
  };
}

function summary(session: TerminalSessionState): TerminalSummary {
  return {
    kind:
      session.terminalId.startsWith("task-") || session.terminalId.startsWith("setup-")
        ? "task"
        : "interactive",
    primary: session.primary ?? session.terminalId === DEFAULT_TERMINAL_ID,
    generation: session.generation,
    taskStatus: session.taskStatus,
    workspaceId: session.workspaceId,
    terminalId: session.terminalId,
    cwd: session.cwd,
    worktreePath: session.worktreePath,
    status: session.status,
    pid: session.pid,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    hasRunningSubprocess: session.hasRunningSubprocess,
    label: terminalWireLabel(session),
    updatedAt: session.updatedAt,
  };
}

function shouldPublishTerminalMetadataEvent(event: TerminalEvent): boolean {
  switch (event.type) {
    case "started":
    case "restarted":
    case "exited":
    case "closed":
    case "error":
    case "activity":
      return true;
    case "output":
    case "cleared":
      return false;
  }
}

function terminalEventToAttachEvent(event: TerminalEvent): TerminalAttachStreamEvent | null {
  switch (event.type) {
    case "started":
      return {
        type: "snapshot",
        snapshot: event.snapshot,
      };
    case "output":
    case "exited":
    case "closed":
    case "error":
    case "cleared":
    case "restarted":
    case "activity":
      return event;
  }
}

function isDuplicateAttachSnapshotEvent(
  event: TerminalEvent,
  initialSnapshot: TerminalSessionSnapshot,
) {
  return typeof event.sequence === "number" && typeof initialSnapshot.sequence === "number"
    ? event.sequence <= initialSnapshot.sequence
    : event.type === "started" &&
        event.snapshot.workspaceId === initialSnapshot.workspaceId &&
        event.snapshot.terminalId === initialSnapshot.terminalId &&
        event.snapshot.updatedAt <= initialSnapshot.updatedAt;
}

function advanceEventSequence(session: TerminalSessionState): {
  readonly updatedAt: string;
  readonly sequence: number;
} {
  const updatedAt = DateTime.formatIso(DateTime.nowUnsafe());
  session.eventSequence += 1;
  session.updatedAt = updatedAt;
  return { updatedAt, sequence: session.eventSequence };
}

function cleanupProcessHandles(session: TerminalSessionState): void {
  session.unsubscribeData?.();
  session.unsubscribeData = null;
  session.unsubscribeExit?.();
  session.unsubscribeExit = null;
}

function enqueueProcessEvent(
  session: TerminalSessionState,
  expectedPid: number,
  event: PendingProcessEvent,
): boolean {
  if (!session.process || session.status !== "running" || session.pid !== expectedPid) {
    return false;
  }

  session.pendingProcessEvents.push(event);
  if (session.processEventDrainRunning) {
    return false;
  }

  session.processEventDrainRunning = true;
  return true;
}

function defaultShellResolver(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "win32") {
    return "pwsh.exe";
  }
  return env.SHELL ?? "bash";
}

function normalizeShellCommand(
  value: string | undefined,
  platform: NodeJS.Platform,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  if (platform === "win32") {
    return trimmed;
  }

  const firstToken = trimmed.split(/\s+/g)[0]?.trim();
  if (!firstToken) return null;
  return firstToken.replace(/^['"]|['"]$/g, "");
}

function basenameForPlatform(command: string, platform: NodeJS.Platform): string {
  const normalized =
    platform === "win32" ? command.replaceAll("/", "\\") : command.replaceAll("\\", "/");
  const parts = normalized
    .split(platform === "win32" ? /\\+/ : /\/+/)
    .filter((part) => part.length > 0);
  return parts.at(-1) ?? normalized;
}

function joinWindowsPath(...parts: ReadonlyArray<string>): string {
  return parts
    .map((part, index) => {
      if (index === 0) return part.replace(/[\\/]+$/g, "");
      return part.replace(/^[\\/]+|[\\/]+$/g, "");
    })
    .filter((part) => part.length > 0)
    .join("\\");
}

function shellCandidateFromCommand(
  command: string | null,
  platform: NodeJS.Platform,
): ShellCandidate | null {
  if (!command || command.length === 0) return null;
  const shellName = basenameForPlatform(command, platform).toLowerCase();
  if (platform === "win32" && (shellName === "pwsh.exe" || shellName === "powershell.exe")) {
    return { shell: command, args: ["-NoLogo"] };
  }
  if (platform !== "win32" && shellName === "zsh") {
    return { shell: command, args: ["-o", "nopromptsp"] };
  }
  return { shell: command };
}

function windowsSystemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
}

function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  return joinWindowsPath(
    windowsSystemRoot(env),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function windowsCmdPath(env: NodeJS.ProcessEnv): string {
  return joinWindowsPath(windowsSystemRoot(env), "System32", "cmd.exe");
}

function formatShellCandidate(candidate: ShellCandidate): string {
  if (!candidate.args || candidate.args.length === 0) return candidate.shell;
  return `${candidate.shell} ${candidate.args.join(" ")}`;
}

function uniqueShellCandidates(candidates: Array<ShellCandidate | null>): ShellCandidate[] {
  const seen = new Set<string>();
  const ordered: ShellCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = formatShellCandidate(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

function resolveShellCandidates(
  shellResolver: () => string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ShellCandidate[] {
  const requested = shellCandidateFromCommand(
    normalizeShellCommand(shellResolver(), platform),
    platform,
  );

  if (platform === "win32") {
    return uniqueShellCandidates([
      requested,
      shellCandidateFromCommand("pwsh.exe", platform),
      shellCandidateFromCommand(windowsPowerShellPath(env), platform),
      shellCandidateFromCommand("powershell.exe", platform),
      shellCandidateFromCommand(env.ComSpec ?? null, platform),
      shellCandidateFromCommand(windowsCmdPath(env), platform),
      shellCandidateFromCommand("cmd.exe", platform),
    ]);
  }

  return uniqueShellCandidates([
    requested,
    shellCandidateFromCommand(normalizeShellCommand(env.SHELL, platform), platform),
    shellCandidateFromCommand("/bin/zsh", platform),
    shellCandidateFromCommand("/bin/bash", platform),
    shellCandidateFromCommand("/bin/sh", platform),
    shellCandidateFromCommand("zsh", platform),
    shellCandidateFromCommand("bash", platform),
    shellCandidateFromCommand("sh", platform),
  ]);
}

function isRetryableShellSpawnError(error: PtyAdapter.PtySpawnError): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (typeof current === "string") {
      messages.push(current);
      continue;
    }

    if (current instanceof Error) {
      messages.push(current.message);
      if (current.cause) {
        queue.push(current.cause);
      }
      continue;
    }

    if (typeof current === "object") {
      const value = current as { message?: unknown; cause?: unknown };
      if (typeof value.message === "string") {
        messages.push(value.message);
      }
      if (value.cause) {
        queue.push(value.cause);
      }
    }
  }

  const message = messages.join(" ").toLowerCase();
  return (
    message.includes("posix_spawnp failed") ||
    message.includes("enoent") ||
    message.includes("not found") ||
    message.includes("file not found") ||
    message.includes("no such file")
  );
}

function parseFirstChildPidFromPgrep(stdout: string): number | null {
  for (const line of stdout.split(/\r?\n/g)) {
    const n = Number.parseInt(line.trim(), 10);
    if (Number.isInteger(n) && n > 0) {
      return n;
    }
  }
  return null;
}

function windowsInspectSubprocess(
  terminalPid: number,
  platform: NodeJS.Platform,
): Effect.Effect<
  TerminalSubprocessInspectResult,
  TerminalSubprocessCheckError,
  ProcessRunner.ProcessRunner
> {
  const command =
    'Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { Write-Output "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }';
  return Effect.gen(function* () {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    return yield* processRunner.run({
      // powershell.exe is a real executable — never spawn it through cmd.exe
      // shell mode, which would re-tokenize the `-Command` payload (pipes,
      // semicolons) before PowerShell ever sees it.
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", command],
      timeout: "1500 millis",
      maxOutputBytes: 32_768,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    });
  }).pipe(
    Effect.map((result) => {
      if (result.code !== 0) {
        return { hasRunningSubprocess: false, childCommand: null, processIds: [] } as const;
      }
      const processNameById = new Map<number, string>();
      const childrenByParent = new Map<number, number[]>();
      for (const line of result.stdout.split(/\r?\n/g)) {
        const [pidRaw, parentPidRaw, nameRaw] = line.trim().split("|", 3);
        const pid = Number(pidRaw);
        const parentPid = Number(parentPidRaw);
        if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue;
        processNameById.set(pid, nameRaw?.trim() ?? "");
        const children = childrenByParent.get(parentPid) ?? [];
        children.push(pid);
        childrenByParent.set(parentPid, children);
      }
      const directChildren = childrenByParent.get(terminalPid) ?? [];
      const childPid = directChildren[0];
      if (childPid === undefined) {
        return { hasRunningSubprocess: false, childCommand: null, processIds: [] } as const;
      }
      const processIds = new Set<number>([terminalPid]);
      const pending = [terminalPid];
      while (pending.length > 0) {
        const parentPid = pending.pop();
        if (parentPid === undefined) continue;
        for (const pid of childrenByParent.get(parentPid) ?? []) {
          if (processIds.has(pid)) continue;
          processIds.add(pid);
          pending.push(pid);
        }
      }
      const normalized = normalizeChildCommandName(processNameById.get(childPid) ?? "", platform);
      return {
        hasRunningSubprocess: true,
        childCommand: normalized ? truncateTerminalWireLabel(normalized) : null,
        processIds: [...processIds],
      } as const;
    }),
    Effect.mapError(
      (cause) =>
        new TerminalSubprocessCheckError({
          cause,
          terminalPid,
          command: "powershell",
        }),
    ),
  );
}

const posixInspectSubprocess = Effect.fn("terminal.posixInspectSubprocess")(function* (
  terminalPid: number,
  platform: NodeJS.Platform,
): Effect.fn.Return<
  TerminalSubprocessInspectResult,
  TerminalSubprocessCheckError,
  ProcessRunner.ProcessRunner
> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const runPgrep = processRunner
    .run({
      command: "pgrep",
      args: ["-P", String(terminalPid)],
      timeout: "1 second",
      maxOutputBytes: 32_768,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new TerminalSubprocessCheckError({
            cause,
            terminalPid,
            command: "pgrep",
          }),
      ),
    );

  const runPs = processRunner
    .run({
      command: "ps",
      args: ["-eo", "pid=,ppid="],
      timeout: "1 second",
      maxOutputBytes: 262_144,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new TerminalSubprocessCheckError({
            cause,
            terminalPid,
            command: "ps",
          }),
      ),
    );

  let childPid: number | null = null;

  const pgrepResult = yield* Effect.exit(runPgrep);
  if (pgrepResult._tag === "Success") {
    if (pgrepResult.value.code === 0) {
      childPid = parseFirstChildPidFromPgrep(pgrepResult.value.stdout);
    } else if (pgrepResult.value.code === 1) {
      return { hasRunningSubprocess: false, childCommand: null, processIds: [] };
    }
  }

  if (childPid === null) {
    const psResult = yield* Effect.exit(runPs);
    if (psResult._tag === "Failure" || psResult.value.code !== 0) {
      return { hasRunningSubprocess: false, childCommand: null, processIds: [] };
    }
    for (const line of psResult.value.stdout.split(/\r?\n/g)) {
      const [pidRaw, ppidRaw] = line.trim().split(/\s+/g);
      const pid = Number(pidRaw);
      const ppid = Number(ppidRaw);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
      if (ppid === terminalPid) {
        childPid = pid;
        break;
      }
    }
  }

  if (childPid === null) {
    return { hasRunningSubprocess: false, childCommand: null, processIds: [] };
  }

  const runComm = processRunner.run({
    command: "ps",
    args: ["-p", String(childPid), "-o", "comm="],
    timeout: "1 second",
    maxOutputBytes: 8_192,
    outputMode: "truncate",
    timeoutBehavior: "timedOutResult",
  });

  const commResult = yield* Effect.exit(runComm);
  let rawComm: string | null = null;
  if (commResult._tag === "Success" && commResult.value && commResult.value.code === 0) {
    rawComm = commResult.value.stdout.trim();
  }

  if (!rawComm || rawComm.length === 0) {
    const runArgs = processRunner.run({
      command: "ps",
      args: ["-p", String(childPid), "-o", "args="],
      timeout: "1 second",
      maxOutputBytes: 16_384,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    });
    const argsResult = yield* Effect.exit(runArgs);
    if (argsResult._tag === "Success" && argsResult.value && argsResult.value.code === 0) {
      const first = argsResult.value.stdout.trim().split(/\s+/)[0] ?? "";
      rawComm = first.length > 0 ? first : null;
    }
  }

  const normalized = rawComm ? normalizeChildCommandName(rawComm, platform) : null;
  const processIds = new Set<number>([terminalPid]);
  const psResult = yield* Effect.exit(runPs);
  if (psResult._tag === "Success" && psResult.value.code === 0) {
    const childrenByParent = new Map<number, number[]>();
    for (const line of psResult.value.stdout.split(/\r?\n/g)) {
      const [pidRaw, ppidRaw] = line.trim().split(/\s+/g);
      const pid = Number(pidRaw);
      const ppid = Number(ppidRaw);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
      const children = childrenByParent.get(ppid) ?? [];
      children.push(pid);
      childrenByParent.set(ppid, children);
    }
    const pending = [terminalPid];
    while (pending.length > 0) {
      const parentPid = pending.pop();
      if (parentPid === undefined) continue;
      for (const child of childrenByParent.get(parentPid) ?? []) {
        if (processIds.has(child)) continue;
        processIds.add(child);
        pending.push(child);
      }
    }
  } else {
    processIds.add(childPid);
  }
  return {
    hasRunningSubprocess: true,
    childCommand: normalized ? truncateTerminalWireLabel(normalized) : null,
    processIds: [...processIds],
  };
});

function defaultSubprocessInspectorForPlatform(platform: NodeJS.Platform) {
  return Effect.fn("terminal.defaultSubprocessInspector")(function* (terminalPid: number) {
    if (!Number.isInteger(terminalPid) || terminalPid <= 0) {
      return { hasRunningSubprocess: false, childCommand: null, processIds: [] };
    }
    if (platform === "win32") {
      return yield* windowsInspectSubprocess(terminalPid, platform);
    }
    return yield* posixInspectSubprocess(terminalPid, platform);
  });
}

function capHistory(history: string, maxLines: number): string {
  if (history.length === 0) return history;
  const hasTrailingNewline = history.endsWith("\n");
  const lines = history.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  if (lines.length <= maxLines) return history;
  const capped = lines.slice(lines.length - maxLines).join("\n");
  return hasTrailingNewline ? `${capped}\n` : capped;
}

function isCsiFinalByte(codePoint: number): boolean {
  return codePoint >= 0x40 && codePoint <= 0x7e;
}

function shouldStripCsiSequence(body: string, finalByte: string): boolean {
  if (finalByte === "n") {
    return true;
  }
  if (finalByte === "R" && /^[0-9;?]*$/.test(body)) {
    return true;
  }
  if (finalByte === "c" && /^[>0-9;?]*$/.test(body)) {
    return true;
  }
  return false;
}

function shouldStripOscSequence(content: string): boolean {
  return /^(10|11|12);(?:\?|rgb:)/.test(content);
}

function stripStringTerminator(value: string): string {
  if (value.endsWith("\u001b\\")) {
    return value.slice(0, -2);
  }
  const lastCharacter = value.at(-1);
  if (lastCharacter === "\u0007" || lastCharacter === "\u009c") {
    return value.slice(0, -1);
  }
  return value;
}

function findStringTerminatorIndex(input: string, start: number): number | null {
  for (let index = start; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    if (codePoint === 0x07 || codePoint === 0x9c) {
      return index + 1;
    }
    if (codePoint === 0x1b && input.charCodeAt(index + 1) === 0x5c) {
      return index + 2;
    }
  }
  return null;
}

function isEscapeIntermediateByte(codePoint: number): boolean {
  return codePoint >= 0x20 && codePoint <= 0x2f;
}

function isEscapeFinalByte(codePoint: number): boolean {
  return codePoint >= 0x30 && codePoint <= 0x7e;
}

function findEscapeSequenceEndIndex(input: string, start: number): number | null {
  let cursor = start;
  while (cursor < input.length && isEscapeIntermediateByte(input.charCodeAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= input.length) {
    return null;
  }
  return isEscapeFinalByte(input.charCodeAt(cursor)) ? cursor + 1 : start + 1;
}

function sanitizeTerminalHistoryChunk(
  pendingControlSequence: string,
  data: string,
): { visibleText: string; pendingControlSequence: string } {
  const input = `${pendingControlSequence}${data}`;
  let visibleText = "";
  let index = 0;

  const append = (value: string) => {
    visibleText += value;
  };

  while (index < input.length) {
    const codePoint = input.charCodeAt(index);

    if (codePoint === 0x1b) {
      const nextCodePoint = input.charCodeAt(index + 1);
      if (Number.isNaN(nextCodePoint)) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }

      if (nextCodePoint === 0x5b) {
        let cursor = index + 2;
        while (cursor < input.length) {
          if (isCsiFinalByte(input.charCodeAt(cursor))) {
            const sequence = input.slice(index, cursor + 1);
            const body = input.slice(index + 2, cursor);
            if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
              append(sequence);
            }
            index = cursor + 1;
            break;
          }
          cursor += 1;
        }
        if (cursor >= input.length) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        continue;
      }

      if (
        nextCodePoint === 0x5d ||
        nextCodePoint === 0x50 ||
        nextCodePoint === 0x5e ||
        nextCodePoint === 0x5f
      ) {
        const terminatorIndex = findStringTerminatorIndex(input, index + 2);
        if (terminatorIndex === null) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        const sequence = input.slice(index, terminatorIndex);
        const content = stripStringTerminator(input.slice(index + 2, terminatorIndex));
        if (nextCodePoint !== 0x5d || !shouldStripOscSequence(content)) {
          append(sequence);
        }
        index = terminatorIndex;
        continue;
      }

      const escapeSequenceEndIndex = findEscapeSequenceEndIndex(input, index + 1);
      if (escapeSequenceEndIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      append(input.slice(index, escapeSequenceEndIndex));
      index = escapeSequenceEndIndex;
      continue;
    }

    if (codePoint === 0x9b) {
      let cursor = index + 1;
      while (cursor < input.length) {
        if (isCsiFinalByte(input.charCodeAt(cursor))) {
          const sequence = input.slice(index, cursor + 1);
          const body = input.slice(index + 1, cursor);
          if (!shouldStripCsiSequence(body, input[cursor] ?? "")) {
            append(sequence);
          }
          index = cursor + 1;
          break;
        }
        cursor += 1;
      }
      if (cursor >= input.length) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      continue;
    }

    if (codePoint === 0x9d || codePoint === 0x90 || codePoint === 0x9e || codePoint === 0x9f) {
      const terminatorIndex = findStringTerminatorIndex(input, index + 1);
      if (terminatorIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      const sequence = input.slice(index, terminatorIndex);
      const content = stripStringTerminator(input.slice(index + 1, terminatorIndex));
      if (codePoint !== 0x9d || !shouldStripOscSequence(content)) {
        append(sequence);
      }
      index = terminatorIndex;
      continue;
    }

    append(input[index] ?? "");
    index += 1;
  }

  return { visibleText, pendingControlSequence: "" };
}

function legacySafeWorkspaceId(workspaceId: string): string {
  return workspaceId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function toSafeWorkspaceId(workspaceId: string): string {
  return `terminal_${Encoding.encodeBase64Url(workspaceId)}`;
}

function toSafeTerminalId(terminalId: string): string {
  return Encoding.encodeBase64Url(terminalId);
}

function toSessionKey(workspaceId: string, terminalId: string): string {
  return `${workspaceId}\u0000${terminalId}`;
}

function shouldExcludeTerminalEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (normalizedKey.startsWith("T3CODE_")) {
    return true;
  }
  if (normalizedKey.startsWith("VITE_")) {
    return true;
  }
  return TERMINAL_ENV_BLOCKLIST.has(normalizedKey);
}

// Marker variables the AppImage runtime injects into the process it launches.
// They describe the AppImage itself, not the user's session, so terminals must
// not inherit them.
const APPIMAGE_RUNTIME_ENV_KEYS = ["APPIMAGE", "APPDIR", "ARGV0", "OWD"] as const;
// PATH-style variables the AppImage runtime prepends with its temporary mount
// (e.g. /tmp/.mount_T3-XXXX/usr/bin). Only the mount segments are dropped; the
// user's real entries are preserved.
const APPIMAGE_PATH_LIKE_ENV_KEYS = ["PATH", "LD_LIBRARY_PATH"] as const;

function isPathSegmentUnderAppDir(segment: string, appDir: string): boolean {
  return segment === appDir || segment.startsWith(`${appDir}/`);
}

// On Linux AppImage builds the runtime mounts the app under a temporary dir and
// injects APPIMAGE/APPDIR/ARGV0/OWD plus mount entries on PATH/LD_LIBRARY_PATH.
// The integrated terminal inherits the server process environment, so without
// this scrub those leak into the PTY and tools resolve against the AppImage
// mount instead of the user's real environment (e.g. `php` reporting
// PHP_BINARY as the AppImage path). See issue #1699. The scrub is gated on an
// actual AppImage launch so non-AppImage environments are left untouched.
function stripAppImageRuntimeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.APPIMAGE === undefined && env.APPDIR === undefined) return env;

  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const key of APPIMAGE_RUNTIME_ENV_KEYS) {
    delete scrubbed[key];
  }

  const appDir = env.APPDIR?.replace(/\/+$/, "");
  if (appDir) {
    for (const key of APPIMAGE_PATH_LIKE_ENV_KEYS) {
      const value = scrubbed[key];
      if (value === undefined) continue;
      const kept = value
        .split(":")
        .filter((segment) => segment.length > 0 && !isPathSegmentUnderAppDir(segment, appDir));
      if (kept.length > 0) {
        scrubbed[key] = kept.join(":");
      } else {
        delete scrubbed[key];
      }
    }
  }

  return scrubbed;
}

function createTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv?: Record<string, string> | null,
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeTerminalEnvKey(key)) continue;
    spawnEnv[key] = value;
  }
  if (runtimeEnv) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      spawnEnv[key] = value;
    }
  }
  return stripAppImageRuntimeEnv(spawnEnv);
}

function normalizedRuntimeEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!env) return null;
  const entries = Object.entries(env);
  if (entries.length === 0) return null;
  return Object.fromEntries(entries.toSorted(([left], [right]) => left.localeCompare(right)));
}

interface TerminalManagerOptions {
  logsDir: string;
  historyLineLimit?: number;
  ptyAdapter: PtyAdapter.PtyAdapter["Service"];
  shellResolver?: () => string;
  env?: NodeJS.ProcessEnv;
  subprocessInspector?: TerminalSubprocessInspector;
  subprocessPollIntervalMs?: number;
  processKillGraceMs?: number;
  maxRetainedInactiveSessions?: number;
  registerTerminalProcesses?: (input: {
    readonly workspaceId: string;
    readonly terminalId: string;
    readonly processIds: ReadonlyArray<number>;
  }) => Effect.Effect<void>;
  unregisterTerminal?: (input: {
    readonly workspaceId: string;
    readonly terminalId: string;
  }) => Effect.Effect<void>;
}

export const make = Effect.fn("TerminalManager.make")(function* () {
  const { terminalLogsDir } = yield* ServerConfig.ServerConfig;
  const ptyAdapter = yield* PtyAdapter.PtyAdapter;
  const portDiscovery = yield* PortScanner.PortDiscovery;
  return yield* makeWithOptions({
    logsDir: terminalLogsDir,
    ptyAdapter,
    registerTerminalProcesses: portDiscovery.registerTerminalProcesses,
    unregisterTerminal: portDiscovery.unregisterTerminal,
  });
});

export const makeWithOptions = Effect.fn("TerminalManager.makeWithOptions")(function* (
  options: TerminalManagerOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  const logsDir = options.logsDir;
  const historyLineLimit = options.historyLineLimit ?? DEFAULT_HISTORY_LINE_LIMIT;
  const platform = yield* HostProcessPlatform;
  // Terminals must inherit the user's full environment (minus the blocklist
  // applied in createTerminalSpawnEnv) — an allowlist here silently strips
  // things like PSModulePath, DISPLAY, proxies, and toolchain variables.
  // `options.env` is the test seam.
  const baseEnv = options.env ?? process.env;
  const shellResolver = options.shellResolver ?? (() => defaultShellResolver(platform, baseEnv));
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const subprocessInspector =
    options.subprocessInspector ??
    ((terminalPid) =>
      defaultSubprocessInspectorForPlatform(platform)(terminalPid).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      ));
  const subprocessPollIntervalMs =
    options.subprocessPollIntervalMs ?? DEFAULT_SUBPROCESS_POLL_INTERVAL_MS;
  const processKillGraceMs = options.processKillGraceMs ?? DEFAULT_PROCESS_KILL_GRACE_MS;
  const maxRetainedInactiveSessions =
    options.maxRetainedInactiveSessions ?? DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS;
  const registerTerminalProcesses = options.registerTerminalProcesses ?? (() => Effect.void);
  const unregisterTerminal = options.unregisterTerminal ?? (() => Effect.void);

  yield* fileSystem.makeDirectory(logsDir, { recursive: true }).pipe(Effect.orDie);

  const managerStateRef = yield* SynchronizedRef.make<TerminalManagerState>({
    sessions: new Map(),
    killFibers: new Map(),
  });
  const checkoutLifecycleLock = yield* Semaphore.make(1);
  const invalidatedWorkspaces = new Set<string>();
  const deletedProjects = new Set<ProjectId>();
  const workspaceLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
  const workspaces = new Map<string, TerminalWorkspace>();
  const savedSessions = new Map<string, TerminalSummary>();
  const metadataCodec = Schema.fromJsonString(
    Schema.Struct({ workspace: Schema.NullOr(TerminalWorkspace), session: TerminalSummary }),
  );
  const metadataLock = yield* Semaphore.make(1);
  const metadataPath = (workspaceId: string, terminalId: string) =>
    path.join(
      logsDir,
      `workspace-session-${NodeCrypto.createHash("sha256").update(workspaceId).update("\0").update(terminalId).digest("hex")}.json`,
    );
  const persistSessionMetadata = Effect.fn("terminal.persistSessionMetadata")(function* (
    session: TerminalSessionState,
  ) {
    const value = summary(session);
    savedSessions.set(toSessionKey(session.workspaceId, session.terminalId), value);
    yield* metadataLock
      .withPermit(
        Effect.gen(function* () {
          const encoded = yield* Schema.encodeEffect(metadataCodec)({
            workspace: workspaces.get(session.workspaceId) ?? null,
            session: value,
          });
          const destination = metadataPath(session.workspaceId, session.terminalId);
          yield* fileSystem.writeFileString(`${destination}.tmp`, encoded);
          yield* fileSystem.rename(`${destination}.tmp`, destination);
        }),
      )
      .pipe(Effect.ignoreCause({ log: true }));
  });
  const directoryIdentity = Effect.fn("terminal.directoryIdentity")(function* (cwd: string) {
    const info = yield* fileSystem
      .stat(cwd)
      .pipe(
        Effect.mapError(
          () => new TerminalWorkspaceError({ message: `Checkout unavailable: ${cwd}` }),
        ),
      );
    if (info.type !== "Directory")
      return yield* new TerminalWorkspaceError({ message: `Checkout is not a directory: ${cwd}` });
    return `${info.dev}:${Option.getOrElse(info.ino, () => 0)}:${Option.match(info.birthtime, { onNone: () => "", onSome: (date) => String(date.getTime()) })}`;
  });
  const workspaceIdentity = Effect.fn("terminal.workspaceIdentity")(function* (
    projectId: ProjectId,
    cwd: string,
  ) {
    const identity = yield* directoryIdentity(cwd);
    return NodeCrypto.createHash("sha256")
      .update(projectId)
      .update("\0")
      .update(cwd)
      .update("\0")
      .update(identity)
      .digest("hex");
  });
  const resolvePath = (cwd: string) =>
    fileSystem
      .realPath(cwd)
      .pipe(
        Effect.mapError(
          () => new TerminalWorkspaceError({ message: `Checkout unavailable: ${cwd}` }),
        ),
      );
  const gitPath = Effect.fn("terminal.gitPath")(function* (cwd: string, flag: string) {
    const result = yield* processRunner
      .run({
        command: "git",
        cwd,
        args: ["rev-parse", "--path-format=absolute", flag],
        maxOutputBytes: 16_384,
        timeout: "10 seconds",
      })
      .pipe(
        Effect.mapError(
          () => new TerminalWorkspaceError({ message: "Unable to verify worktree membership." }),
        ),
      );
    if (result.code !== 0)
      return yield* new TerminalWorkspaceError({
        message: "The requested directory is not a worktree of this project.",
      });
    return yield* resolvePath(result.stdout.trim());
  });
  const resolveWorkspace = Effect.fn("terminal.resolveWorkspace")(function* (
    input: Omit<TerminalWorkspace, "id">,
  ) {
    if (deletedProjects.has(input.projectId))
      return yield* new TerminalWorkspaceError({ message: "The project has been removed." });
    const root = yield* resolvePath(input.cwd);
    const cwd = input.worktreePath ? yield* resolvePath(input.worktreePath) : root;
    if (cwd !== root) {
      const common = yield* gitPath(root, "--git-common-dir");
      const candidateCommon = yield* gitPath(cwd, "--git-common-dir");
      const candidateRoot = yield* gitPath(cwd, "--show-toplevel");
      if (common !== candidateCommon || cwd !== candidateRoot) {
        return yield* new TerminalWorkspaceError({
          message: "The requested directory is not a worktree of this project.",
        });
      }
    }
    const id = yield* workspaceIdentity(input.projectId, cwd);
    if (workspaces.get(id)?.available === false || invalidatedWorkspaces.has(id))
      return yield* new TerminalWorkspaceError({
        message: "This checkout was removed and cannot be rebound to its old sessions.",
      });
    const workspace = { ...input, id, cwd, worktreePath: cwd === root ? null : cwd };
    workspaces.set(id, workspace);
    return workspace;
  });
  const validateWorkspace = Effect.fn("terminal.validateWorkspace")(function* (
    workspaceId: string,
    launchCwd?: string,
  ) {
    const workspace = workspaces.get(workspaceId);
    if (!workspace)
      return yield* new TerminalWorkspaceError({
        message:
          "Unknown terminal checkout. Resolve the project checkout before opening a terminal; older clients must update.",
      });
    if (workspace.available === false || deletedProjects.has(workspace.projectId))
      return yield* new TerminalWorkspaceError({ message: "This terminal checkout was removed." });
    const currentId = yield* workspaceIdentity(workspace.projectId, workspace.cwd);
    if (currentId !== workspace.id)
      return yield* new TerminalWorkspaceError({
        message:
          "This checkout was replaced. Its old terminal cannot control the replacement directory.",
      });
    if (launchCwd) {
      const launch = yield* resolvePath(launchCwd);
      const relative = path.relative(workspace.cwd, launch);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return yield* new TerminalWorkspaceError({
          message: "The launch directory is outside the selected checkout.",
        });
      }
    }
  });
  const listWorkspaces = Effect.fn("terminal.listWorkspaces")(function* (input: {
    projectId: ProjectId;
    cwd: string;
  }) {
    const mainResult = yield* resolveWorkspace({ ...input, worktreePath: null }).pipe(
      Effect.option,
    );
    const main = Option.getOrNull(mainResult);
    if (!main) {
      return [...workspaces.values()]
        .filter((entry) => entry.projectId === input.projectId)
        .map((entry) => (entry.worktreePath === null ? { ...entry, available: false } : entry));
    }
    const result = yield* processRunner
      .run({
        command: "git",
        cwd: main.cwd,
        args: ["worktree", "list", "--porcelain", "-z"],
        maxOutputBytes: 1_000_000,
        timeout: "10 seconds",
      })
      .pipe(Effect.option);
    if (Option.isSome(result) && result.value.code === 0) {
      for (const entry of result.value.stdout.split("\0")) {
        if (!entry.startsWith("worktree ")) continue;
        yield* resolveWorkspace({ ...input, worktreePath: entry.slice(9) }).pipe(Effect.ignore);
      }
    }
    return [
      main,
      ...[...workspaces.values()].filter(
        (workspace) => workspace.projectId === input.projectId && workspace.id !== main.id,
      ),
    ];
  });
  const terminalEventListeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const workerScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void));

  const publishEvent = (event: TerminalEvent) =>
    Effect.gen(function* () {
      if (shouldPublishTerminalMetadataEvent(event)) {
        const state = yield* SynchronizedRef.get(managerStateRef);
        const session = state.sessions.get(toSessionKey(event.workspaceId, event.terminalId));
        if (session) yield* persistSessionMetadata(session);
      }
      for (const listener of terminalEventListeners) {
        yield* listener(event).pipe(Effect.ignoreCause({ log: true }));
      }
    });

  const historyPath = (workspaceId: string, terminalId: string) => {
    const workspacePart = toSafeWorkspaceId(workspaceId);
    if (terminalId === DEFAULT_TERMINAL_ID) {
      return path.join(logsDir, `${workspacePart}.log`);
    }
    return path.join(logsDir, `${workspacePart}_${toSafeTerminalId(terminalId)}.log`);
  };

  const legacyHistoryPath = (workspaceId: string) =>
    path.join(logsDir, `${legacySafeWorkspaceId(workspaceId)}.log`);

  const readManagerState = SynchronizedRef.get(managerStateRef);

  const modifyManagerState = <A>(
    f: (state: TerminalManagerState) => readonly [A, TerminalManagerState],
  ) => SynchronizedRef.modify(managerStateRef, f);

  const getWorkspaceSemaphore = (workspaceId: string) =>
    SynchronizedRef.modifyEffect(workspaceLocksRef, (current) => {
      const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
        current.get(workspaceId),
      );
      return Option.match(existing, {
        onNone: () =>
          Semaphore.make(1).pipe(
            Effect.map((semaphore) => {
              const next = new Map(current);
              next.set(workspaceId, semaphore);
              return [semaphore, next] as const;
            }),
          ),
        onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
      });
    });

  const withWorkspaceLock = <A, E, R>(
    workspaceId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.flatMap(getWorkspaceSemaphore(workspaceId), (semaphore) => semaphore.withPermit(effect));

  const clearKillFiber = Effect.fn("terminal.clearKillFiber")(function* (
    process: PtyAdapter.PtyProcess | null,
  ) {
    if (!process) return;
    const fiber: Option.Option<Fiber.Fiber<void, never>> = yield* modifyManagerState<
      Option.Option<Fiber.Fiber<void, never>>
    >((state) => {
      const existing: Option.Option<Fiber.Fiber<void, never>> = Option.fromNullishOr(
        state.killFibers.get(process),
      );
      if (Option.isNone(existing)) {
        return [Option.none<Fiber.Fiber<void, never>>(), state] as const;
      }
      const killFibers = new Map(state.killFibers);
      killFibers.delete(process);
      return [existing, { ...state, killFibers }] as const;
    });
    if (Option.isSome(fiber)) {
      yield* Fiber.interrupt(fiber.value).pipe(Effect.ignore);
    }
  });

  const registerKillFiber = Effect.fn("terminal.registerKillFiber")(function* (
    process: PtyAdapter.PtyProcess,
    fiber: Fiber.Fiber<void, never>,
  ) {
    yield* modifyManagerState((state) => {
      const killFibers = new Map(state.killFibers);
      killFibers.set(process, fiber);
      return [undefined, { ...state, killFibers }] as const;
    });
  });

  const runKillEscalation = Effect.fn("terminal.runKillEscalation")(function* (
    process: PtyAdapter.PtyProcess,
    workspaceId: string,
    terminalId: string,
  ) {
    const terminated = yield* Effect.try({
      try: () => process.kill("SIGTERM"),
      catch: (cause) =>
        new TerminalProcessSignalError({
          cause,
          signal: "SIGTERM",
          terminalPid: process.pid,
        }),
    }).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("failed to kill terminal process", {
          workspaceId,
          terminalId,
          signal: "SIGTERM",
          cause: error,
        }).pipe(Effect.as(false)),
      ),
    );
    if (!terminated) {
      return;
    }

    yield* Effect.sleep(processKillGraceMs);

    yield* Effect.try({
      try: () => process.kill("SIGKILL"),
      catch: (cause) =>
        new TerminalProcessSignalError({
          cause,
          signal: "SIGKILL",
          terminalPid: process.pid,
        }),
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to force-kill terminal process", {
          workspaceId,
          terminalId,
          signal: "SIGKILL",
          cause: error,
        }),
      ),
    );
  });

  const startKillEscalation = Effect.fn("terminal.startKillEscalation")(function* (
    process: PtyAdapter.PtyProcess,
    workspaceId: string,
    terminalId: string,
  ) {
    const fiber = yield* runKillEscalation(process, workspaceId, terminalId).pipe(
      Effect.ensuring(
        modifyManagerState((state) => {
          if (!state.killFibers.has(process)) {
            return [undefined, state] as const;
          }
          const killFibers = new Map(state.killFibers);
          killFibers.delete(process);
          return [undefined, { ...state, killFibers }] as const;
        }),
      ),
      Effect.forkIn(workerScope),
    );

    yield* registerKillFiber(process, fiber);
  });

  const pendingHistories = new Map<string, string>();
  const persistenceScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(persistenceScope, Exit.void));
  const persistWorker = yield* makeKeyedCoalescingWorker<
    string,
    PersistHistoryRequest,
    never,
    never
  >({
    merge: (current, next) => ({
      history: next.history,
      immediate: current.immediate || next.immediate,
    }),
    process: Effect.fn("terminal.persistHistoryWorker")(function* (sessionKey, request) {
      if (!request.immediate) {
        yield* Effect.sleep(DEFAULT_PERSIST_DEBOUNCE_MS);
      }

      const [workspaceId, terminalId] = sessionKey.split("\u0000");
      if (!workspaceId || !terminalId) {
        return;
      }

      yield* fileSystem.writeFileString(historyPath(workspaceId, terminalId), request.history).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (pendingHistories.get(sessionKey) === request.history)
              pendingHistories.delete(sessionKey);
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("failed to persist terminal history", {
            workspaceId,
            terminalId,
            error,
          }),
        ),
      );
    }),
  }).pipe(Effect.provideService(Scope.Scope, persistenceScope));

  const queuePersist = Effect.fn("terminal.queuePersist")(function* (
    workspaceId: string,
    terminalId: string,
    history: string,
  ) {
    pendingHistories.set(toSessionKey(workspaceId, terminalId), history);
    yield* persistWorker.enqueue(toSessionKey(workspaceId, terminalId), {
      history,
      immediate: false,
    });
  });

  const flushPersist = Effect.fn("terminal.flushPersist")(function* (
    workspaceId: string,
    terminalId: string,
  ) {
    yield* persistWorker.drainKey(toSessionKey(workspaceId, terminalId));
  });

  const persistHistory = Effect.fn("terminal.persistHistory")(function* (
    workspaceId: string,
    terminalId: string,
    history: string,
  ) {
    pendingHistories.set(toSessionKey(workspaceId, terminalId), history);
    yield* persistWorker.enqueue(toSessionKey(workspaceId, terminalId), {
      history,
      immediate: true,
    });
    yield* flushPersist(workspaceId, terminalId);
  });

  const readHistory = Effect.fn("terminal.readHistory")(function* (
    workspaceId: string,
    terminalId: string,
  ) {
    const nextPath = historyPath(workspaceId, terminalId);
    if (
      yield* fileSystem
        .exists(nextPath)
        .pipe(
          Effect.mapError(
            (cause) =>
              new TerminalHistoryError({ operation: "read", workspaceId, terminalId, cause }),
          ),
        )
    ) {
      const raw = yield* fileSystem
        .readFileString(nextPath)
        .pipe(
          Effect.mapError(
            (cause) =>
              new TerminalHistoryError({ operation: "read", workspaceId, terminalId, cause }),
          ),
        );
      const capped = capHistory(raw, historyLineLimit);
      if (capped !== raw) {
        yield* fileSystem
          .writeFileString(nextPath, capped)
          .pipe(
            Effect.mapError(
              (cause) =>
                new TerminalHistoryError({ operation: "truncate", workspaceId, terminalId, cause }),
            ),
          );
      }
      return capped;
    }

    if (terminalId !== DEFAULT_TERMINAL_ID) {
      return "";
    }

    const legacyPath = legacyHistoryPath(workspaceId);
    if (
      !(yield* fileSystem
        .exists(legacyPath)
        .pipe(
          Effect.mapError(
            (cause) =>
              new TerminalHistoryError({ operation: "migrate", workspaceId, terminalId, cause }),
          ),
        ))
    ) {
      return "";
    }

    const raw = yield* fileSystem
      .readFileString(legacyPath)
      .pipe(
        Effect.mapError(
          (cause) =>
            new TerminalHistoryError({ operation: "migrate", workspaceId, terminalId, cause }),
        ),
      );
    const capped = capHistory(raw, historyLineLimit);
    yield* fileSystem
      .writeFileString(nextPath, capped)
      .pipe(
        Effect.mapError(
          (cause) =>
            new TerminalHistoryError({ operation: "migrate", workspaceId, terminalId, cause }),
        ),
      );
    yield* fileSystem.remove(legacyPath, { force: true }).pipe(
      Effect.catch((cleanupError) =>
        Effect.logWarning("failed to remove legacy terminal history", {
          workspaceId,
          error: cleanupError,
        }),
      ),
    );
    return capped;
  });

  const deleteHistory = Effect.fn("terminal.deleteHistory")(function* (
    workspaceId: string,
    terminalId: string,
  ) {
    yield* fileSystem.remove(historyPath(workspaceId, terminalId), { force: true }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to delete terminal history", {
          workspaceId,
          terminalId,
          error,
        }),
      ),
    );
    if (terminalId === DEFAULT_TERMINAL_ID) {
      yield* fileSystem.remove(legacyHistoryPath(workspaceId), { force: true }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to delete terminal history", {
            workspaceId,
            terminalId,
            error,
          }),
        ),
      );
    }
  });

  const deleteAllHistoryForWorkspace = Effect.fn("terminal.deleteAllHistoryForWorkspace")(
    function* (workspaceId: string) {
      const workspacePrefix = `${toSafeWorkspaceId(workspaceId)}_`;
      const entries = yield* fileSystem
        .readDirectory(logsDir, { recursive: false })
        .pipe(Effect.orElseSucceed(() => [] as Array<string>));
      yield* Effect.forEach(
        entries.filter(
          (name) =>
            name === `${toSafeWorkspaceId(workspaceId)}.log` ||
            name === `${legacySafeWorkspaceId(workspaceId)}.log` ||
            name.startsWith(workspacePrefix),
        ),
        (name) =>
          fileSystem.remove(path.join(logsDir, name), { force: true }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to delete terminal histories for workspace", {
                workspaceId,
                error,
              }),
            ),
          ),
        { discard: true },
      );
    },
  );

  const assertValidCwd = Effect.fn("terminal.assertValidCwd")(function* (cwd: string) {
    const stats = yield* fileSystem.stat(cwd).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? new TerminalCwdNotFoundError({ cwd })
            : new TerminalCwdStatError({ cwd, cause }),
      }),
    );
    if (stats.type !== "Directory") {
      return yield* new TerminalCwdNotDirectoryError({ cwd });
    }
  });

  const getSession = Effect.fn("terminal.getSession")(function* (
    workspaceId: string,
    terminalId: string,
  ): Effect.fn.Return<Option.Option<TerminalSessionState>> {
    return yield* Effect.map(readManagerState, (state) =>
      Option.fromNullishOr(state.sessions.get(toSessionKey(workspaceId, terminalId))),
    );
  });

  const restoreSession = Effect.fn("terminal.restoreSession")(function* (
    workspaceId: string,
    terminalId: string,
  ) {
    const current = yield* getSession(workspaceId, terminalId);
    if (Option.isSome(current)) return current;
    const saved = savedSessions.get(toSessionKey(workspaceId, terminalId));
    if (!saved) return Option.none<TerminalSessionState>();
    const session: TerminalSessionState = {
      ...saved,
      generation: saved.generation ?? (yield* Effect.sync(() => NodeCrypto.randomUUID())),
      status: saved.status === "closed" ? "closed" : "exited",
      pid: null,
      history: yield* readHistory(workspaceId, terminalId),
      pendingHistoryControlSequence: "",
      pendingProcessEvents: [],
      pendingProcessEventIndex: 0,
      processEventDrainRunning: false,
      eventSequence: 0,
      cols: DEFAULT_OPEN_COLS,
      rows: DEFAULT_OPEN_ROWS,
      process: null,
      unsubscribeData: null,
      unsubscribeExit: null,
      hasRunningSubprocess: false,
      childCommandLabel: null,
      runtimeEnv: null,
    };
    yield* modifyManagerState((state) => {
      const sessions = new Map(state.sessions);
      sessions.set(toSessionKey(workspaceId, terminalId), session);
      return [undefined, { ...state, sessions }] as const;
    });
    return Option.some(session);
  });

  const requireSession = Effect.fn("terminal.requireSession")(function* (
    workspaceId: string,
    terminalId: string,
  ): Effect.fn.Return<TerminalSessionState, TerminalSessionLookupError> {
    return yield* Effect.flatMap(getSession(workspaceId, terminalId), (session) =>
      Option.match(session, {
        onNone: () =>
          Effect.fail(
            new TerminalSessionLookupError({
              workspaceId,
              terminalId,
            }),
          ),
        onSome: Effect.succeed,
      }),
    );
  });

  const sessionsForWorkspace = Effect.fn("terminal.sessionsForWorkspace")(function* (
    workspaceId: string,
  ) {
    return yield* readManagerState.pipe(
      Effect.map((state) =>
        [...state.sessions.values()].filter((session) => session.workspaceId === workspaceId),
      ),
    );
  });

  const evictInactiveSessionsIfNeeded = Effect.fn("terminal.evictInactiveSessionsIfNeeded")(
    function* () {
      yield* modifyManagerState((state) => {
        const inactiveSessions = [...state.sessions.values()].filter(
          (session) => session.status !== "running",
        );
        if (inactiveSessions.length <= maxRetainedInactiveSessions) {
          return [undefined, state] as const;
        }

        inactiveSessions.sort(
          (left, right) =>
            left.updatedAt.localeCompare(right.updatedAt) ||
            left.workspaceId.localeCompare(right.workspaceId) ||
            left.terminalId.localeCompare(right.terminalId),
        );

        const sessions = new Map(state.sessions);

        const toEvict = inactiveSessions.length - maxRetainedInactiveSessions;
        for (const session of inactiveSessions.slice(0, toEvict)) {
          const key = toSessionKey(session.workspaceId, session.terminalId);
          sessions.delete(key);
        }

        return [undefined, { ...state, sessions }] as const;
      });
    },
  );

  const drainProcessEvents = Effect.fn("terminal.drainProcessEvents")(function* (
    session: TerminalSessionState,
    expectedPid: number,
  ) {
    while (true) {
      const action: DrainProcessEventAction = yield* Effect.sync(() => {
        if (session.pid !== expectedPid || !session.process || session.status !== "running") {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          return { type: "idle" } as const;
        }

        const nextEvent = session.pendingProcessEvents[session.pendingProcessEventIndex];
        if (!nextEvent) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          return { type: "idle" } as const;
        }

        session.pendingProcessEventIndex += 1;
        if (session.pendingProcessEventIndex >= session.pendingProcessEvents.length) {
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
        }

        if (nextEvent.type === "output") {
          const sanitized = sanitizeTerminalHistoryChunk(
            session.pendingHistoryControlSequence,
            nextEvent.data,
          );
          session.pendingHistoryControlSequence = sanitized.pendingControlSequence;
          if (sanitized.visibleText.length > 0) {
            session.history = capHistory(
              `${session.history}${sanitized.visibleText}`,
              historyLineLimit,
            );
          }
          const eventStamp = advanceEventSequence(session);

          return {
            type: "output",
            workspaceId: session.workspaceId,
            terminalId: session.terminalId,
            sequence: eventStamp.sequence,
            history: sanitized.visibleText.length > 0 ? session.history : null,
            data: nextEvent.data,
          } as const;
        }

        const process = session.process;
        cleanupProcessHandles(session);
        session.process = null;
        session.pid = null;
        session.hasRunningSubprocess = false;
        session.childCommandLabel = null;
        session.status = "exited";
        session.pendingHistoryControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        session.exitCode = Number.isInteger(nextEvent.event.exitCode)
          ? nextEvent.event.exitCode
          : null;
        session.exitSignal = Number.isInteger(nextEvent.event.signal)
          ? nextEvent.event.signal
          : null;
        const eventStamp = advanceEventSequence(session);

        return {
          type: "exit",
          process,
          workspaceId: session.workspaceId,
          terminalId: session.terminalId,
          sequence: eventStamp.sequence,
          exitCode: session.exitCode,
          exitSignal: session.exitSignal,
        } as const;
      });

      if (action.type === "idle") {
        return;
      }

      if (action.type === "output") {
        if (action.history !== null) {
          yield* queuePersist(action.workspaceId, action.terminalId, action.history);
        }

        yield* publishEvent({
          type: "output",
          workspaceId: action.workspaceId,
          terminalId: action.terminalId,
          sequence: action.sequence,
          data: action.data,
        });
        continue;
      }

      yield* clearKillFiber(action.process);
      yield* unregisterTerminal({
        workspaceId: action.workspaceId,
        terminalId: action.terminalId,
      });
      yield* publishEvent({
        type: "exited",
        workspaceId: action.workspaceId,
        terminalId: action.terminalId,
        sequence: action.sequence,
        exitCode: action.exitCode,
        exitSignal: action.exitSignal,
      });
      yield* evictInactiveSessionsIfNeeded();
      return;
    }
  });

  const stopProcess = Effect.fn("terminal.stopProcess")(function* (session: TerminalSessionState) {
    const process = session.process;
    if (!process) return;

    const updatedAt = yield* nowIso;
    yield* modifyManagerState((state) => {
      cleanupProcessHandles(session);
      session.process = null;
      session.pid = null;
      session.hasRunningSubprocess = false;
      session.childCommandLabel = null;
      session.status = "exited";
      session.pendingHistoryControlSequence = "";
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.processEventDrainRunning = false;
      session.updatedAt = updatedAt;
      return [undefined, state] as const;
    });

    yield* clearKillFiber(process);
    yield* unregisterTerminal({
      workspaceId: session.workspaceId,
      terminalId: session.terminalId,
    });
    yield* startKillEscalation(process, session.workspaceId, session.terminalId);
    yield* evictInactiveSessionsIfNeeded();
  });

  const trySpawn = Effect.fn("terminal.trySpawn")(function* (
    shellCandidates: ReadonlyArray<ShellCandidate>,
    spawnEnv: NodeJS.ProcessEnv,
    session: TerminalSessionState,
    index = 0,
    lastError: PtyAdapter.PtySpawnError | null = null,
  ): Effect.fn.Return<
    { process: PtyAdapter.PtyProcess; shellLabel: string },
    PtyAdapter.PtySpawnError
  > {
    if (index >= shellCandidates.length) {
      return yield* new PtyAdapter.PtySpawnError({
        adapter: "terminal-manager",
        attemptedShells: shellCandidates.map((candidate) => formatShellCandidate(candidate)),
        ...(lastError ? { cause: lastError } : {}),
      });
    }

    const candidate = shellCandidates[index];
    if (!candidate) {
      return yield* (
        lastError ??
          new PtyAdapter.PtySpawnError({
            adapter: "terminal-manager",
            attemptedShells: [],
          })
      );
    }

    const attempt = yield* Effect.result(
      options.ptyAdapter.spawn({
        shell: candidate.shell,
        ...(candidate.args ? { args: candidate.args } : {}),
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
        env: spawnEnv,
      }),
    );

    if (attempt._tag === "Success") {
      return {
        process: attempt.success,
        shellLabel: formatShellCandidate(candidate),
      };
    }

    const spawnError = attempt.failure;
    if (!isRetryableShellSpawnError(spawnError)) {
      return yield* spawnError;
    }

    return yield* trySpawn(shellCandidates, spawnEnv, session, index + 1, spawnError);
  });

  const startSession = Effect.fn("terminal.startSession")(function* (
    session: TerminalSessionState,
    input: TerminalStartInput,
    eventType: "started" | "restarted",
  ) {
    yield* stopProcess(session);
    yield* Effect.annotateCurrentSpan({
      "terminal.workspace_id": session.workspaceId,
      "terminal.id": session.terminalId,
      "terminal.event_type": eventType,
      "terminal.cwd": input.cwd,
    });

    session.generation = yield* Effect.sync(() => NodeCrypto.randomUUID());
    const startingAt = yield* nowIso;
    yield* modifyManagerState((state) => {
      session.status = "starting";
      session.cwd = input.cwd;
      session.worktreePath = input.worktreePath ?? null;
      session.cols = input.cols;
      session.rows = input.rows;
      session.exitCode = null;
      session.exitSignal = null;
      session.hasRunningSubprocess = false;
      session.childCommandLabel = null;
      session.pendingProcessEvents = [];
      session.pendingProcessEventIndex = 0;
      session.processEventDrainRunning = false;
      session.updatedAt = startingAt;
      return [undefined, state] as const;
    });

    let ptyProcess: PtyAdapter.PtyProcess | null = null;
    let startedShell: string | null = null;

    const startResult = yield* Effect.result(
      increment(terminalSessionsTotal, { lifecycle: eventType }).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const shellCandidates = resolveShellCandidates(shellResolver, platform, baseEnv);
            const terminalEnv = createTerminalSpawnEnv(baseEnv, session.runtimeEnv);
            const spawnResult = yield* trySpawn(shellCandidates, terminalEnv, session);
            ptyProcess = spawnResult.process;
            startedShell = spawnResult.shellLabel;

            const processPid = ptyProcess.pid;
            const unsubscribeData = ptyProcess.onData((data) => {
              if (!enqueueProcessEvent(session, processPid, { type: "output", data })) {
                return;
              }
              runFork(drainProcessEvents(session, processPid));
            });
            const unsubscribeExit = ptyProcess.onExit((event) => {
              if (!enqueueProcessEvent(session, processPid, { type: "exit", event })) {
                return;
              }
              runFork(drainProcessEvents(session, processPid));
            });

            let eventStamp: ReturnType<typeof advanceEventSequence> = {
              updatedAt: session.updatedAt,
              sequence: session.eventSequence,
            };
            yield* modifyManagerState((state) => {
              session.process = ptyProcess;
              session.pid = processPid;
              session.status = "running";
              session.unsubscribeData = unsubscribeData;
              session.unsubscribeExit = unsubscribeExit;
              eventStamp = advanceEventSequence(session);
              return [undefined, state] as const;
            });

            yield* publishEvent({
              type: eventType,
              workspaceId: session.workspaceId,
              terminalId: session.terminalId,
              sequence: eventStamp.sequence,
              snapshot: snapshot(session),
            });
          }),
        ),
      ),
    );

    if (startResult._tag === "Success") {
      return;
    }

    {
      const error = startResult.failure;
      if (ptyProcess) {
        yield* startKillEscalation(ptyProcess, session.workspaceId, session.terminalId);
      }

      yield* modifyManagerState((state) => {
        cleanupProcessHandles(session);
        session.status = "error";
        session.pid = null;
        session.process = null;
        session.hasRunningSubprocess = false;
        session.childCommandLabel = null;
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        advanceEventSequence(session);
        return [undefined, state] as const;
      });
      yield* unregisterTerminal({
        workspaceId: session.workspaceId,
        terminalId: session.terminalId,
      });

      yield* evictInactiveSessionsIfNeeded();

      const message = error.message;
      yield* publishEvent({
        type: "error",
        workspaceId: session.workspaceId,
        terminalId: session.terminalId,
        sequence: session.eventSequence,
        message,
      });
      yield* Effect.logError("failed to start terminal", {
        workspaceId: session.workspaceId,
        terminalId: session.terminalId,
        cause: error,
        ...(startedShell ? { shell: startedShell } : {}),
      });
    }
  });

  const closeSession = Effect.fn("terminal.closeSession")(function* (
    workspaceId: string,
    terminalId: string,
    deleteHistoryOnClose: boolean,
  ) {
    const session = yield* getSession(workspaceId, terminalId);
    const closedEventSequence = Option.isSome(session) ? session.value.eventSequence + 1 : 0;

    if (Option.isSome(session)) {
      yield* stopProcess(session.value);
      yield* unregisterTerminal({ workspaceId, terminalId });
      yield* persistHistory(workspaceId, terminalId, session.value.history);
    }

    yield* flushPersist(workspaceId, terminalId);

    if (Option.isSome(session)) {
      session.value.status = "closed";
      session.value.updatedAt = yield* nowIso;
      session.value.eventSequence = closedEventSequence;
      yield* publishEvent({
        type: "closed",
        workspaceId,
        terminalId,
        sequence: closedEventSequence,
      });
    }

    if (deleteHistoryOnClose) {
      if (Option.isSome(session)) session.value.history = "";
      yield* deleteHistory(workspaceId, terminalId);
    }
  });

  const pollSubprocessActivity = Effect.fn("terminal.pollSubprocessActivity")(function* () {
    const state = yield* readManagerState;
    const runningSessions = [...state.sessions.values()].filter(
      (session): session is TerminalSessionState & { pid: number } =>
        session.status === "running" && Number.isInteger(session.pid),
    );

    if (runningSessions.length === 0) {
      return;
    }

    const checkSubprocessActivity = Effect.fn("terminal.checkSubprocessActivity")(function* (
      session: TerminalSessionState & { pid: number },
    ) {
      const terminalPid = session.pid;
      const inspectResult = yield* subprocessInspector(terminalPid).pipe(
        Effect.map(Option.some),
        Effect.catch((reason) =>
          Effect.logWarning("failed to check terminal subprocess activity", {
            workspaceId: session.workspaceId,
            terminalId: session.terminalId,
            terminalPid,
            reason,
          }).pipe(Effect.as(Option.none<TerminalSubprocessInspectResult>())),
        ),
      );

      if (Option.isNone(inspectResult)) {
        return;
      }

      const next = inspectResult.value;
      yield* registerTerminalProcesses({
        workspaceId: session.workspaceId,
        terminalId: session.terminalId,
        processIds: next.processIds,
      });
      const nextChildLabel = next.hasRunningSubprocess ? next.childCommand : null;
      const event = yield* modifyManagerState((state) => {
        const liveSession: Option.Option<TerminalSessionState> = Option.fromNullishOr(
          state.sessions.get(toSessionKey(session.workspaceId, session.terminalId)),
        );
        if (
          Option.isNone(liveSession) ||
          liveSession.value.status !== "running" ||
          liveSession.value.pid !== terminalPid ||
          (liveSession.value.hasRunningSubprocess === next.hasRunningSubprocess &&
            liveSession.value.childCommandLabel === nextChildLabel)
        ) {
          return [Option.none(), state] as const;
        }

        liveSession.value.hasRunningSubprocess = next.hasRunningSubprocess;
        liveSession.value.childCommandLabel = nextChildLabel;
        const eventStamp = advanceEventSequence(liveSession.value);

        return [
          Option.some({
            type: "activity" as const,
            workspaceId: liveSession.value.workspaceId,
            terminalId: liveSession.value.terminalId,
            sequence: eventStamp.sequence,
            hasRunningSubprocess: next.hasRunningSubprocess,
            label: terminalWireLabel(liveSession.value),
          }),
          state,
        ] as const;
      });

      if (Option.isSome(event)) {
        yield* publishEvent(event.value);
      }
    });

    yield* Effect.forEach(runningSessions, checkSubprocessActivity, {
      concurrency: "unbounded",
      discard: true,
    });
  });

  const hasRunningSessions = readManagerState.pipe(
    Effect.map((state) =>
      [...state.sessions.values()].some((session) => session.status === "running"),
    ),
  );

  yield* Effect.forever(
    hasRunningSessions.pipe(
      Effect.flatMap((active) =>
        active
          ? pollSubprocessActivity().pipe(
              Effect.flatMap(() => Effect.sleep(subprocessPollIntervalMs)),
            )
          : Effect.sleep(subprocessPollIntervalMs),
      ),
    ),
  ).pipe(Effect.forkIn(workerScope));

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Scope.close(persistenceScope, Exit.void);
      yield* Effect.forEach(
        pendingHistories,
        ([key, history]) => {
          const [workspaceId, terminalId] = key.split("\u0000");
          return workspaceId && terminalId
            ? fileSystem
                .writeFileString(historyPath(workspaceId, terminalId), history)
                .pipe(Effect.ignoreCause({ log: true }))
            : Effect.void;
        },
        { discard: true },
      );
      pendingHistories.clear();
      const sessions = yield* modifyManagerState(
        (state) =>
          [
            [...state.sessions.values()],
            {
              ...state,
              sessions: new Map(),
            },
          ] as const,
      );

      const cleanupSession = Effect.fn("terminal.cleanupSession")(function* (
        session: TerminalSessionState,
      ) {
        cleanupProcessHandles(session);
        yield* fileSystem
          .writeFileString(historyPath(session.workspaceId, session.terminalId), session.history)
          .pipe(Effect.ignoreCause({ log: true }));
        if (!session.process) return;
        yield* clearKillFiber(session.process);
        yield* runKillEscalation(session.process, session.workspaceId, session.terminalId);
      });

      yield* Effect.forEach(sessions, cleanupSession, {
        concurrency: "unbounded",
        discard: true,
      });
    }).pipe(Effect.ignoreCause({ log: true })),
  );

  const openLocked = Effect.fn("terminal.openLocked")(function* (input: TerminalOpenInput) {
    yield* assertValidCwd(input.cwd);
    input = {
      ...input,
      cwd: yield* resolvePath(input.cwd),
      ...(input.worktreePath ? { worktreePath: yield* resolvePath(input.worktreePath) } : {}),
    };
    const terminalId = input.terminalId;
    if (invalidatedWorkspaces.has(input.workspaceId))
      return yield* new TerminalWorkspaceError({ message: "This checkout was removed." });
    if (workspaces.has(input.workspaceId)) yield* validateWorkspace(input.workspaceId, input.cwd);
    yield* assertValidCwd(input.cwd);

    const sessionKey = toSessionKey(input.workspaceId, terminalId);
    const existing = yield* restoreSession(input.workspaceId, terminalId);
    if (Option.isNone(existing)) {
      yield* flushPersist(input.workspaceId, terminalId);
      const history = yield* readHistory(input.workspaceId, terminalId);
      const cols = input.cols ?? DEFAULT_OPEN_COLS;
      const rows = input.rows ?? DEFAULT_OPEN_ROWS;
      const session: TerminalSessionState = {
        generation: yield* Effect.sync(() => NodeCrypto.randomUUID()),
        ...(terminalId.startsWith("task-") ? { taskStatus: "unknown" as const } : {}),
        workspaceId: input.workspaceId,
        terminalId,
        cwd: input.cwd,
        worktreePath: input.worktreePath ?? null,
        status: "starting",
        pid: null,
        history,
        pendingHistoryControlSequence: "",
        pendingProcessEvents: [],
        pendingProcessEventIndex: 0,
        processEventDrainRunning: false,
        exitCode: null,
        exitSignal: null,
        updatedAt: yield* nowIso,
        eventSequence: 0,
        cols,
        rows,
        process: null,
        unsubscribeData: null,
        unsubscribeExit: null,
        hasRunningSubprocess: false,
        childCommandLabel: null,
        runtimeEnv: normalizedRuntimeEnv(input.env),
      };

      const createdSession = session;
      yield* modifyManagerState((state) => {
        const sessions = new Map(state.sessions);
        sessions.set(sessionKey, createdSession);
        return [undefined, { ...state, sessions }] as const;
      });

      yield* evictInactiveSessionsIfNeeded();
      yield* startSession(
        session,
        {
          workspaceId: input.workspaceId,
          terminalId,
          cwd: input.cwd,
          ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
          cols,
          rows,
          ...(input.env ? { env: input.env } : {}),
        },
        "started",
      );
      return snapshot(session);
    }

    const liveSession = existing.value;
    if (!liveSession.process) return snapshot(liveSession);
    const nextRuntimeEnv = normalizedRuntimeEnv(input.env);
    const currentRuntimeEnv = liveSession.runtimeEnv;
    const targetCols = input.cols ?? liveSession.cols;
    const targetRows = input.rows ?? liveSession.rows;
    const runtimeEnvChanged = !Equal.equals(currentRuntimeEnv, nextRuntimeEnv);
    const nextWorktreePath =
      input.worktreePath !== undefined ? (input.worktreePath ?? null) : liveSession.worktreePath;
    const launchContextChanged =
      liveSession.cwd !== input.cwd ||
      runtimeEnvChanged ||
      liveSession.worktreePath !== nextWorktreePath;

    if (launchContextChanged) {
      return yield* new TerminalWorkspaceError({
        message:
          "This terminal belongs to a different launch context. Open a new terminal or explicitly restart it.",
      });
    }
    // An open is idempotent, including for ended sessions. Only Restart launches
    // another generation; a stale view must never resurrect a shared process.
    if (!liveSession.process) return snapshot(liveSession);

    if (liveSession.cols !== targetCols || liveSession.rows !== targetRows) {
      yield* resizePtyProcess(liveSession, liveSession.process, targetCols, targetRows);
      liveSession.cols = targetCols;
      liveSession.rows = targetRows;
      liveSession.updatedAt = yield* nowIso;
    }

    return snapshot(liveSession);
  });

  const open: TerminalManager["Service"]["open"] = (input) =>
    checkoutLifecycleLock.withPermit(
      withWorkspaceLock(
        input.workspaceId,
        Effect.gen(function* () {
          if (!input.selectPrimary) return yield* openLocked(input);
          const eligible = (yield* sessionsForWorkspace(input.workspaceId))
            .filter(
              (session) => session.process !== null && !session.terminalId.startsWith("task-"),
            )
            .sort(
              (left, right) =>
                Number(summary(right).primary) - Number(summary(left).primary) ||
                left.terminalId.localeCompare(right.terminalId),
            );
          const current = eligible[0];
          const defaultSession = yield* restoreSession(input.workspaceId, DEFAULT_TERMINAL_ID);
          const terminalId =
            current?.terminalId ??
            (Option.isNone(defaultSession)
              ? DEFAULT_TERMINAL_ID
              : yield* Effect.sync(() => NodeCrypto.randomUUID()));
          const selected = current
            ? snapshot(current)
            : yield* openLocked({ ...input, terminalId, selectPrimary: false });
          for (const saved of [...savedSessions.values()].filter(
            (entry) =>
              entry.workspaceId === input.workspaceId &&
              entry.primary &&
              entry.terminalId !== terminalId,
          ))
            yield* restoreSession(input.workspaceId, saved.terminalId);
          for (const session of yield* sessionsForWorkspace(input.workspaceId)) {
            const primary = session.terminalId === terminalId;
            if (summary(session).primary === primary) continue;
            session.primary = primary;
            yield* persistSessionMetadata(session);
            yield* publishEvent({
              type: "activity",
              workspaceId: session.workspaceId,
              terminalId: session.terminalId,
              sequence: session.eventSequence,
              hasRunningSubprocess: session.hasRunningSubprocess,
              label: terminalWireLabel(session),
            });
          }
          return { ...selected, primary: true };
        }),
      ),
    );

  const openOrAttachForStream = (input: TerminalAttachInput) =>
    withWorkspaceLock(
      input.workspaceId,
      Effect.gen(function* () {
        const terminalId = input.terminalId;
        const existing = yield* restoreSession(input.workspaceId, terminalId);

        if (Option.isNone(existing)) {
          return yield* new TerminalSessionLookupError({
            workspaceId: input.workspaceId,
            terminalId,
          });
        }
        const session = existing.value;
        return snapshot(session);
      }),
    );

  const readAllTerminalMetadata = () =>
    readManagerState.pipe(
      Effect.map((state) => {
        let inactive = 0;
        return [
          ...new Map([
            ...savedSessions,
            ...[...state.sessions.values()].map(
              (session) =>
                [toSessionKey(session.workspaceId, session.terminalId), summary(session)] as const,
            ),
          ]).values(),
        ]
          .sort(
            (left, right) =>
              right.updatedAt.localeCompare(left.updatedAt) ||
              left.workspaceId.localeCompare(right.workspaceId) ||
              left.terminalId.localeCompare(right.terminalId),
          )
          .filter(
            (session) =>
              session.status === "running" ||
              session.status === "starting" ||
              ++inactive <= MAX_RETAINED_TERMINAL_SUMMARIES,
          );
      }),
    );

  const readTerminalMetadata = (input: {
    readonly workspaceId: string;
    readonly terminalId: string;
  }) =>
    getSession(input.workspaceId, input.terminalId).pipe(
      Effect.map((session) => (Option.isSome(session) ? summary(session.value) : null)),
    );

  const subscribe: TerminalManager["Service"]["subscribe"] = (listener) =>
    Effect.sync(() => {
      terminalEventListeners.add(listener);
      return () => {
        terminalEventListeners.delete(listener);
      };
    });

  const attachStream: TerminalManager["Service"]["attachStream"] = (input, listener) => {
    let unsubscribe: (() => void) | null = null;

    return Effect.gen(function* () {
      const bufferedEvents: TerminalEvent[] = [];
      let deliverLive = false;

      unsubscribe = yield* subscribe((event) => {
        if (event.workspaceId !== input.workspaceId || event.terminalId !== input.terminalId) {
          return Effect.void;
        }

        if (!deliverLive) {
          bufferedEvents.push(event);
          return Effect.void;
        }

        const attachEvent = terminalEventToAttachEvent(event);
        return attachEvent ? listener(attachEvent) : Effect.void;
      });

      const initialSnapshot = yield* openOrAttachForStream(input);

      yield* listener({
        type: "snapshot",
        snapshot: initialSnapshot,
      });

      for (const event of bufferedEvents) {
        if (isDuplicateAttachSnapshotEvent(event, initialSnapshot)) {
          continue;
        }

        const attachEvent = terminalEventToAttachEvent(event);
        if (attachEvent) {
          yield* listener(attachEvent);
        }
      }

      deliverLive = true;
      return () => {
        unsubscribe?.();
        unsubscribe = null;
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.flatMap(
          Effect.sync(() => {
            unsubscribe?.();
            unsubscribe = null;
          }),
          () => Effect.failCause(cause),
        ),
      ),
    );
  };

  const metadataEventFromTerminalEvent = (
    event: TerminalEvent,
  ): Effect.Effect<TerminalMetadataStreamEvent | null> => {
    if (!shouldPublishTerminalMetadataEvent(event)) {
      return Effect.succeed(null);
    }

    return readTerminalMetadata({
      workspaceId: event.workspaceId,
      terminalId: event.terminalId,
    }).pipe(
      Effect.map((terminal) =>
        terminal
          ? {
              type: "upsert" as const,
              terminal,
            }
          : null,
      ),
    );
  };

  const offerMetadataEvent = (
    listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
    event: TerminalEvent,
  ) =>
    metadataEventFromTerminalEvent(event).pipe(
      Effect.flatMap((metadataEvent) => (metadataEvent ? listener(metadataEvent) : Effect.void)),
    );

  const subscribeMetadata: TerminalManager["Service"]["subscribeMetadata"] = (listener) => {
    let unsubscribe: (() => void) | null = null;

    return Effect.gen(function* () {
      const bufferedEvents: TerminalEvent[] = [];
      let deliverLive = false;

      unsubscribe = yield* subscribe((event) => {
        if (!deliverLive) {
          bufferedEvents.push(event);
          return Effect.void;
        }

        return offerMetadataEvent(listener, event);
      });

      const terminals = yield* readAllTerminalMetadata();
      yield* listener({
        type: "snapshot",
        terminals,
      });

      for (const event of bufferedEvents) {
        yield* offerMetadataEvent(listener, event);
      }

      deliverLive = true;
      return () => {
        unsubscribe?.();
        unsubscribe = null;
      };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.flatMap(
          Effect.sync(() => {
            unsubscribe?.();
            unsubscribe = null;
          }),
          () => Effect.failCause(cause),
        ),
      ),
    );
  };

  const checkGeneration = (session: TerminalSessionState, generation: string | undefined) =>
    generation !== undefined && generation !== session.generation
      ? Effect.fail(
          new TerminalWorkspaceError({
            message:
              "This terminal process was replaced. Reattach before sending input or changing it.",
          }),
        )
      : Effect.void;

  const writeLocked = Effect.fn("terminal.write")(function* (
    input: TerminalWriteInput,
    requireRunning = false,
  ) {
    if (invalidatedWorkspaces.has(input.workspaceId))
      return yield* new TerminalWorkspaceError({ message: "This checkout was removed." });
    if (workspaces.has(input.workspaceId)) yield* validateWorkspace(input.workspaceId);
    const terminalId = input.terminalId;
    const session = yield* requireSession(input.workspaceId, terminalId);
    yield* checkGeneration(session, input.generation);
    const process = session.process;
    if (!process || session.status !== "running") {
      if (session.status === "exited" && !requireRunning) return;
      return yield* new TerminalNotRunningError({
        workspaceId: input.workspaceId,
        terminalId,
      });
    }
    yield* Effect.try({
      try: () => process.write(input.data),
      catch: (cause) =>
        new TerminalWriteError({
          workspaceId: input.workspaceId,
          terminalId,
          terminalPid: process.pid,
          cause,
        }),
    });
  });

  const write: TerminalManager["Service"]["write"] = (input) =>
    withWorkspaceLock(input.workspaceId, writeLocked(input));

  const runTask: TerminalManager["Service"]["runTask"] = (input) =>
    checkoutLifecycleLock.withPermit(
      withWorkspaceLock(
        input.workspaceId,
        Effect.gen(function* () {
          if (!input.terminalId.startsWith("task-"))
            return yield* new TerminalWorkspaceError({
              message: "Automated commands require a dedicated task terminal.",
            });
          const existing = yield* restoreSession(input.workspaceId, input.terminalId);
          if (Option.isSome(existing)) {
            if (existing.value.taskStatus !== "submitted")
              return yield* new TerminalWorkspaceError({
                message:
                  "This task has an unknown execution outcome. Inspect its output before deliberately running it again; retrying will not replay the command.",
              });
            return snapshot(existing.value);
          }
          const opened = yield* openLocked(input);
          yield* writeLocked(
            {
              workspaceId: input.workspaceId,
              terminalId: input.terminalId,
              generation: opened.generation,
              data: input.command,
            },
            true,
          );
          const session = yield* getSession(input.workspaceId, input.terminalId);
          if (Option.isSome(session)) {
            session.value.taskStatus = "submitted";
            yield* persistSessionMetadata(session.value);
            return snapshot(session.value);
          }
          return opened;
        }),
      ),
    );

  const resizeLocked = Effect.fn("terminal.resize")(function* (input: TerminalResizeInput) {
    const session = yield* getSession(input.workspaceId, input.terminalId);
    // ResizeObserver traffic can already be in flight when the UI closes the session.
    if (Option.isNone(session)) {
      return;
    }
    yield* checkGeneration(session.value, input.generation);
    const process = session.value.process;
    if (!process || session.value.status !== "running") {
      return;
    }
    yield* resizePtyProcess(session.value, process, input.cols, input.rows);
    session.value.cols = input.cols;
    session.value.rows = input.rows;
    session.value.updatedAt = yield* nowIso;
  });

  const resize: TerminalManager["Service"]["resize"] = (input) =>
    withWorkspaceLock(input.workspaceId, resizeLocked(input));

  const clear: TerminalManager["Service"]["clear"] = (input) =>
    withWorkspaceLock(
      input.workspaceId,
      Effect.gen(function* () {
        const terminalId = input.terminalId;
        const session = yield* requireSession(input.workspaceId, terminalId);
        yield* checkGeneration(session, input.generation);
        session.history = "";
        session.pendingHistoryControlSequence = "";
        session.pendingProcessEvents = [];
        session.pendingProcessEventIndex = 0;
        session.processEventDrainRunning = false;
        const eventStamp = advanceEventSequence(session);
        yield* persistHistory(input.workspaceId, terminalId, session.history);
        yield* publishEvent({
          type: "cleared",
          workspaceId: input.workspaceId,
          terminalId,
          sequence: eventStamp.sequence,
        });
      }),
    );

  const restart: TerminalManager["Service"]["restart"] = (input) =>
    checkoutLifecycleLock.withPermit(
      withWorkspaceLock(
        input.workspaceId,
        Effect.gen(function* () {
          input = {
            ...input,
            cwd: yield* resolvePath(input.cwd),
            ...(input.worktreePath ? { worktreePath: yield* resolvePath(input.worktreePath) } : {}),
          };
          yield* increment(terminalRestartsTotal, { scope: "workspace" });
          const terminalId = input.terminalId;
          if (invalidatedWorkspaces.has(input.workspaceId))
            return yield* new TerminalWorkspaceError({ message: "This checkout was removed." });
          if (workspaces.has(input.workspaceId))
            yield* validateWorkspace(input.workspaceId, input.cwd);
          yield* assertValidCwd(input.cwd);

          const sessionKey = toSessionKey(input.workspaceId, terminalId);
          const existingSession = yield* restoreSession(input.workspaceId, terminalId);
          let session: TerminalSessionState;
          if (Option.isNone(existingSession)) {
            const cols = input.cols ?? DEFAULT_OPEN_COLS;
            const rows = input.rows ?? DEFAULT_OPEN_ROWS;
            session = {
              generation: yield* Effect.sync(() => NodeCrypto.randomUUID()),
              workspaceId: input.workspaceId,
              terminalId,
              cwd: input.cwd,
              worktreePath: input.worktreePath ?? null,
              status: "starting",
              pid: null,
              history: "",
              pendingHistoryControlSequence: "",
              pendingProcessEvents: [],
              pendingProcessEventIndex: 0,
              processEventDrainRunning: false,
              exitCode: null,
              exitSignal: null,
              updatedAt: yield* nowIso,
              eventSequence: 0,
              cols,
              rows,
              process: null,
              unsubscribeData: null,
              unsubscribeExit: null,
              hasRunningSubprocess: false,
              childCommandLabel: null,
              runtimeEnv: normalizedRuntimeEnv(input.env),
            };
            const createdSession = session;
            yield* modifyManagerState((state) => {
              const sessions = new Map(state.sessions);
              sessions.set(sessionKey, createdSession);
              return [undefined, { ...state, sessions }] as const;
            });
            yield* evictInactiveSessionsIfNeeded();
          } else {
            session = existingSession.value;
            yield* checkGeneration(session, input.generation);
            yield* stopProcess(session);
            session.cwd = input.cwd;
            session.worktreePath = input.worktreePath ?? null;
            session.runtimeEnv = normalizedRuntimeEnv(input.env);
          }

          const cols = input.cols ?? session.cols;
          const rows = input.rows ?? session.rows;

          session.history = "";
          session.pendingHistoryControlSequence = "";
          session.pendingProcessEvents = [];
          session.pendingProcessEventIndex = 0;
          session.processEventDrainRunning = false;
          yield* persistHistory(input.workspaceId, terminalId, session.history);
          yield* startSession(
            session,
            {
              workspaceId: input.workspaceId,
              terminalId,
              cwd: input.cwd,
              ...(input.worktreePath !== undefined ? { worktreePath: input.worktreePath } : {}),
              cols,
              rows,
              ...(input.env ? { env: input.env } : {}),
            },
            "restarted",
          );
          return snapshot(session);
        }),
      ),
    );

  const close: TerminalManager["Service"]["close"] = (input) =>
    withWorkspaceLock(
      input.workspaceId,
      Effect.gen(function* () {
        if (input.terminalId) {
          const existing = yield* restoreSession(input.workspaceId, input.terminalId);
          if (Option.isSome(existing)) yield* checkGeneration(existing.value, input.generation);
          yield* closeSession(input.workspaceId, input.terminalId, input.deleteHistory === true);
          return;
        }

        const workspaceSessions = yield* sessionsForWorkspace(input.workspaceId);
        yield* Effect.forEach(
          workspaceSessions,
          (session) => closeSession(input.workspaceId, session.terminalId, false),
          { discard: true },
        );

        if (input.deleteHistory) {
          yield* deleteAllHistoryForWorkspace(input.workspaceId);
        }
      }),
    );

  const legacyHistory: TerminalManager["Service"]["legacyHistory"] = Effect.fn(
    "terminal.legacyHistory",
  )(function* (historyId) {
    const ownedFiles = new Set(
      (yield* readAllTerminalMetadata()).map((session) =>
        path.basename(historyPath(session.workspaceId, session.terminalId)),
      ),
    );
    const files = (yield* fileSystem
      .readDirectory(logsDir)
      .pipe(
        Effect.mapError(
          () => new TerminalWorkspaceError({ message: "Unable to read legacy terminal history." }),
        ),
      ))
      .filter((name) => name.endsWith(".log") && !ownedFiles.has(name))
      .sort();
    if (historyId !== undefined && !files.includes(historyId))
      return yield* new TerminalWorkspaceError({
        message: "Legacy terminal history is unavailable.",
      });
    const text = historyId
      ? yield* fileSystem.readFileString(path.join(logsDir, historyId)).pipe(
          Effect.map((value) => capHistory(value, historyLineLimit)),
          Effect.mapError(
            () =>
              new TerminalWorkspaceError({ message: "Unable to read legacy terminal history." }),
          ),
        )
      : null;
    return {
      histories: files.map((id, index) => {
        const saved = [...savedSessions.values()].find(
          (entry) => path.basename(historyPath(entry.workspaceId, entry.terminalId)) === id,
        );
        return {
          id,
          label: saved ? `${saved.label} ? ${saved.cwd}` : `Legacy terminal ${index + 1}`,
        };
      }),
      text,
    };
  });

  const closeProject: TerminalManager["Service"]["closeProject"] = (projectId) =>
    checkoutLifecycleLock.withPermit(
      Effect.gen(function* () {
        deletedProjects.add(projectId);
        for (const workspace of [...workspaces.values()].filter(
          (entry) => entry.projectId === projectId,
        )) {
          // Removal of the owner is persisted as an absent workspace. Retained output
          // never grants permission to launch another shell in a deleted project.
          invalidatedWorkspaces.add(workspace.id);
          workspaces.delete(workspace.id);
          const ids = new Set(
            [...savedSessions.values()]
              .filter((session) => session.workspaceId === workspace.id)
              .map((session) => session.terminalId),
          );
          for (const session of yield* sessionsForWorkspace(workspace.id))
            ids.add(session.terminalId);
          for (const terminalId of ids) {
            yield* restoreSession(workspace.id, terminalId);
            yield* close({ workspaceId: workspace.id, terminalId });
          }
        }
      }),
    );
  const withCheckoutRemoval: TerminalManager["Service"]["withCheckoutRemoval"] = (
    cwd,
    operation,
    confirmedSessions,
  ) =>
    checkoutLifecycleLock.withPermit(
      Effect.gen(function* () {
        const resolved = yield* resolvePath(cwd);
        const affected = [...workspaces.values()].filter((workspace) => workspace.cwd === resolved);
        const ids = new Set(affected.map((workspace) => workspace.id));
        const state = yield* readManagerState;
        const running = [...state.sessions.values()].filter(
          (session) => ids.has(session.workspaceId) && session.process !== null,
        );
        if (
          running.some(
            (session) =>
              !confirmedSessions?.some(
                (confirmed) =>
                  confirmed.workspaceId === session.workspaceId &&
                  confirmed.terminalId === session.terminalId &&
                  confirmed.generation === session.generation,
              ),
          )
        )
          return yield* new TerminalWorkspaceError({
            message: `This checkout has ${running.length} running terminal session(s). Confirm termination before removing the worktree.`,
            sessions: running.map((session) => ({
              workspaceId: session.workspaceId,
              terminalId: session.terminalId,
              generation: session.generation,
              label: terminalWireLabel(session),
            })),
          });
        for (const session of running)
          yield* close({
            workspaceId: session.workspaceId,
            terminalId: session.terminalId,
            generation: session.generation,
          });
        const result = yield* operation;
        for (const workspace of affected) {
          invalidatedWorkspaces.add(workspace.id);
          workspaces.set(workspace.id, { ...workspace, available: false });
          for (const session of yield* sessionsForWorkspace(workspace.id))
            yield* persistSessionMetadata(session);
        }
        return result;
      }),
    );

  for (const name of yield* fileSystem.readDirectory(logsDir).pipe(Effect.orDie)) {
    if (!name.startsWith("workspace-session-") || !name.endsWith(".json")) continue;
    const record = yield* fileSystem
      .readFileString(path.join(logsDir, name))
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(metadataCodec)), Effect.option);
    if (Option.isNone(record)) continue;
    const { workspace, session } = record.value;
    if (workspace) workspaces.set(workspace.id, workspace);
    savedSessions.set(toSessionKey(session.workspaceId, session.terminalId), {
      ...session,
      status: session.status === "closed" ? "closed" : "exited",
      pid: null,
      hasRunningSubprocess: false,
    });
  }

  return TerminalManager.of({
    legacyHistory,
    closeProject,
    withCheckoutRemoval,
    validateWorkspace,
    listWorkspaces,
    resolveWorkspace,
    runTask,
    open,
    attachStream,
    write,
    resize,
    clear,
    restart,
    close,
    subscribe,
    subscribeMetadata,
  });
});

export const layer = Layer.effect(TerminalManager, make()).pipe(Layer.provide(ProcessRunner.layer));
