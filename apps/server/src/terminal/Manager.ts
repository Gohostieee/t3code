// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto digest is effectful; a sync hash keeps historyPath a plain function.
import * as NodeCrypto from "node:crypto";

import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import {
  DEFAULT_TERMINAL_ID,
  PROVIDER_SETUP_TERMINAL_WORKSPACE_ID,
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
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
  TerminalProviderInstanceNotFoundError,
  TerminalProviderEnvironmentError,
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
  type TerminalObserveInput,
  type TerminalTaskInput,
  type TerminalResizeInput,
  type ResourceMonitorProcessTableEntry,
  type TerminalRestartInput,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
  TerminalSummary,
  type TerminalWriteInput,
  ClaudeSettings,
  CodexSettings,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { mergePathEntries } from "@t3tools/shared/shell";

import { acpRegistryManagedBinaryDirectories } from "@t3tools/provider-acp-registry/server";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
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
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  increment,
  terminalRestartsTotal,
  terminalSessionsTotal,
} from "../observability/Metrics.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as NativeTelemetryClient from "../resourceTelemetry/NativeTelemetryClient.ts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

export {
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalProviderInstanceNotFoundError,
  TerminalProviderEnvironmentError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalWriteError,
};

const DEFAULT_HISTORY_LINE_LIMIT = 5_000;
const DEFAULT_HISTORY_BYTE_LIMIT = 8 * 1024 * 1024;
const MAX_HISTORY_CHUNK_LENGTH = 16 * 1024;
const DEFAULT_PERSIST_DEBOUNCE_MS = 250;
const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;
const MAX_SUBPROCESS_POLL_INTERVAL_MS = 60_000;
// Discover children started without terminal input or output.
const QUIET_SUBPROCESS_SNAPSHOT_EVERY_TICKS = 30;
const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;
const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;
const DEFAULT_OPEN_COLS = 120;
const DEFAULT_OPEN_ROWS = 30;
// The tmux/screen/Zellij keys name the multiplexer pane that launched the server,
// so inheriting them points multiplexer-aware tools at that unrelated pane.
const TERMINAL_ENV_BLOCKLIST = new Set([
  "PORT",
  "ELECTRON_RENDERER_PORT",
  "ELECTRON_RUN_AS_NODE",
  "TMUX",
  "TMUX_PANE",
  "STY",
  "WINDOW",
  "ZELLIJ",
  "ZELLIJ_SESSION_NAME",
  "ZELLIJ_PANE_ID",
]);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const MAX_TERMINAL_LABEL_LENGTH = 128;
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

class TerminalSubprocessCheckError extends Schema.TaggedError<TerminalSubprocessCheckError>()(
  "TerminalSubprocessCheckError",
  {
    cause: Schema.optional(Schema.Defect()),
    command: Schema.Literals(["powershell", "ps", "resource-monitor"]),
    exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
    timedOut: Schema.optional(Schema.Boolean),
    stdoutTruncated: Schema.optional(Schema.Boolean),
  },
) {
  override get message(): string {
    const details = [
      this.exitCode !== undefined && this.exitCode !== null ? `exit code ${this.exitCode}` : null,
      this.timedOut ? "timed out" : null,
      this.stdoutTruncated ? "output truncated" : null,
    ]
      .filter((detail) => detail !== null)
      .join(", ");
    return `Failed to inspect terminal subprocesses with ${this.command}${details.length > 0 ? ` (${details})` : ""}`;
  }
}

class TerminalProcessSignalError extends Schema.TaggedError<TerminalProcessSignalError>()(
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
      wasRemoved?: (result: A) => boolean,
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
      readiness?: {
        readonly beforeWrite: Effect.Effect<void>;
        readonly onOpened: (snapshot: TerminalSessionSnapshot) => Effect.Effect<void>;
      },
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;
    readonly open: (
      input: TerminalOpenInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

    readonly attachStream: (
      input: TerminalAttachInput,
      listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
      registerCleanup?: (stop: () => void) => void,
    ) => Effect.Effect<() => void, TerminalError>;

    readonly observeStream: (
      input: TerminalObserveInput,
      listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
      registerCleanup?: (stop: () => void) => void,
    ) => Effect.Effect<() => void, TerminalError>;

    readonly resyncStream: (
      input: TerminalObserveInput,
      listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
      registerCleanup?: (stop: () => void) => void,
    ) => Effect.Effect<() => void, TerminalError>;

    readonly write: (input: TerminalWriteInput) => Effect.Effect<void, TerminalError>;

    readonly resize: (input: TerminalResizeInput) => Effect.Effect<void, TerminalError>;

    readonly clear: (input: TerminalClearInput) => Effect.Effect<void, TerminalError>;

    /** Resets history before spawning. */
    readonly restart: (
      input: TerminalRestartInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

    /** Omit terminalId to close all sessions for the thread. */
    readonly close: (input: TerminalCloseInput) => Effect.Effect<void, TerminalError>;

    readonly closeIdle: (input: {
      readonly workspaceId: string;
      readonly terminalId?: string;
    }) => Effect.Effect<void>;

    readonly subscribe: (
      listener: (event: TerminalEvent) => Effect.Effect<void>,
      registerCleanup?: (stop: () => void) => void,
    ) => Effect.Effect<() => void>;

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

interface TerminalSessionState {
  primary?: boolean | undefined;
  taskStatus?: "unknown" | "submitted" | undefined;
  generation: string;
  workspaceId: string;
  terminalId: string;
  cwd: string;
  worktreePath: string | null;
  status: TerminalSessionStatus;
  pid: number | null;
  history: BoundedTerminalHistory;
  pendingHistoryControlSequence: string;
  pendingProcessEvents: Array<PendingProcessEvent>;
  pendingProcessEventIndex: number;
  processEventDrainRunning: boolean;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
  eventSequence: number;
  inputCount: number;
  cols: number;
  rows: number;
  process: PtyAdapter.PtyProcess | null;
  unsubscribeData: (() => void) | null;
  unsubscribeExit: (() => void) | null;
  hasRunningSubprocess: boolean;
  childCommandLabel: string | null;
  runtimeEnv: Record<string, string> | null;
}

interface PersistHistoryRequest {
  readonly revision: number;
  history: BoundedTerminalHistory;
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
      history: BoundedTerminalHistory | null;
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
    history: session.history.value(),
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

function terminalActivityMark(session: TerminalSessionState): number {
  return session.eventSequence + session.inputCount;
}

interface QuietTerminalSession {
  readonly process: PtyAdapter.PtyProcess | null;
  readonly mark: number;
  readonly idleSnapshots: number;
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

interface TerminalProcessTableSnapshot {
  readonly childrenByParent: ReadonlyMap<number, ReadonlyArray<number>>;
  readonly commandById: ReadonlyMap<number, string>;
}

function subprocessSnapshotPollDelayMs(pollIntervalMs: number, failureCount: number): number {
  return Math.min(pollIntervalMs * 2 ** failureCount, MAX_SUBPROCESS_POLL_INTERVAL_MS);
}

function parsePosixProcessTable(stdout: string): TerminalProcessTableSnapshot {
  const childrenByParent = new Map<number, number[]>();
  const commandById = new Map<number, string>();
  for (const line of stdout.split(/\r?\n/g)) {
    // The final comm column can contain spaces; only the first two tokens are structural.
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    commandById.set(pid, (match[3] ?? "").trim());
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }
  return { childrenByParent, commandById };
}

function processTableSnapshotFromProcesses(
  processes: ReadonlyArray<ResourceMonitorProcessTableEntry>,
): TerminalProcessTableSnapshot {
  const childrenByParent = new Map<number, number[]>();
  const commandById = new Map<number, string>();
  for (const process of processes) {
    const { pid, ppid: parentPid, name } = process;
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue;
    commandById.set(pid, name.trim());
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }
  return { childrenByParent, commandById };
}

function deriveSubprocessInspectResult(
  snapshot: TerminalProcessTableSnapshot,
  terminalPid: number,
  platform: NodeJS.Platform,
): TerminalSubprocessInspectResult {
  const commandName = (pid: number) =>
    normalizeChildCommandName(snapshot.commandById.get(pid) ?? "", platform);
  const shellName = commandName(terminalPid);
  // Async prompt themes fork childless shell helpers that are not user commands.
  const childPid = (snapshot.childrenByParent.get(terminalPid) ?? []).find(
    (pid) =>
      shellName === null ||
      commandName(pid) !== shellName ||
      (snapshot.childrenByParent.get(pid)?.length ?? 0) > 0,
  );
  if (childPid === undefined) {
    return { hasRunningSubprocess: false, childCommand: null, processIds: [] };
  }
  const processIds = new Set<number>([terminalPid]);
  const pending = [terminalPid];
  while (pending.length > 0) {
    const parentPid = pending.pop();
    if (parentPid === undefined) continue;
    for (const pid of snapshot.childrenByParent.get(parentPid) ?? []) {
      if (processIds.has(pid)) continue;
      processIds.add(pid);
      pending.push(pid);
    }
  }
  const normalized = commandName(childPid);
  return {
    hasRunningSubprocess: true,
    childCommand: normalized ? truncateTerminalWireLabel(normalized) : null,
    processIds: [...processIds],
  };
}

const POSIX_PS_ABSOLUTE_PATHS = ["/bin/ps", "/usr/bin/ps"] as const;

// Resolve ps once; bare-name spawns repeatedly probe long PATHs during one-second polling.
const resolvePosixPsCommand = Effect.fn("terminal.resolvePosixPsCommand")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  for (const candidate of POSIX_PS_ABSOLUTE_PATHS) {
    const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) return candidate;
  }
  return "ps";
});

const posixProcessTableSnapshot = Effect.fn("terminal.posixProcessTableSnapshot")(function* (
  psCommand: string,
): Effect.fn.Return<
  TerminalProcessTableSnapshot,
  TerminalSubprocessCheckError,
  ProcessRunner.ProcessRunner
> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner
    .run({
      command: psCommand,
      args: ["-eo", "pid=,ppid=,comm="],
      timeout: "1 second",
      maxOutputBytes: 524_288,
      outputMode: "truncate",
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new TerminalSubprocessCheckError({
            cause,
            command: "ps",
          }),
      ),
    );
  if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
    // Reject partial tables; treating them as authoritative would clear process ids and mark terminals idle.
    return yield* new TerminalSubprocessCheckError({
      command: "ps",
      exitCode: result.code,
      timedOut: result.timedOut,
      stdoutTruncated: result.stdoutTruncated,
    });
  }
  return parsePosixProcessTable(result.stdout);
});

const windowsProcessTableSnapshot = Effect.fn("terminal.windowsProcessTableSnapshot")(
  function* (): Effect.fn.Return<
    TerminalProcessTableSnapshot,
    TerminalSubprocessCheckError,
    ProcessRunner.ProcessRunner
  > {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const command =
      'Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { Write-Output "$($_.ProcessId)|$($_.ParentProcessId)|$($_.Name)" }';
    const result = yield* processRunner
      .run({
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-Command", command],
        timeout: "1500 millis",
        maxOutputBytes: 262_144,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.mapError(
          (cause) => new TerminalSubprocessCheckError({ cause, command: "powershell" }),
        ),
      );
    if (result.code !== 0 || result.timedOut || result.stdoutTruncated) {
      return yield* new TerminalSubprocessCheckError({
        command: "powershell",
        exitCode: result.code,
        timedOut: result.timedOut,
        stdoutTruncated: result.stdoutTruncated,
      });
    }
    const processes = result.stdout.split(/\r?\n/g).flatMap((line) => {
      const [pidRaw, ppidRaw, name = ""] = line.trim().split("|", 3);
      const pid = Number(pidRaw);
      const ppid = Number(ppidRaw);
      return Number.isInteger(pid) && pid > 0 && Number.isInteger(ppid)
        ? [{ pid, ppid, name }]
        : [];
    });
    return processTableSnapshotFromProcesses(processes);
  },
);

interface TerminalHistoryChunk {
  data: string;
  byteLength: number;
  lineBreaks: number;
}

export class BoundedTerminalHistory {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private chunks: Array<TerminalHistoryChunk | undefined> = [];
  private start = 0;
  private byteLength = 0;
  private lineBreaks = 0;
  // Reading the old string's tail on each append can force chunk concatenation.
  private lastCodeUnit: number | undefined;
  private cachedValue: string | null = "";

  constructor(maxLines: number, initial: string, maxBytes = DEFAULT_HISTORY_BYTE_LIMIT) {
    this.maxLines = maxLines;
    this.maxBytes = maxBytes;
    this.append(initial);
  }

  append(text: string): void {
    if (text.length === 0) return;
    this.cachedValue = null;
    if (this.maxBytes <= 0 || this.maxLines <= 0) {
      this.clear();
      if (this.maxBytes > 0 && text.endsWith("\n")) this.appendChunk("\n");
      return;
    }

    let offset = 0;
    const previous = this.chunks.at(-1);
    const lastCode = this.lastCodeUnit;
    const firstCode = text.charCodeAt(0);
    if (
      previous &&
      lastCode !== undefined &&
      lastCode >= 0xd800 &&
      lastCode <= 0xdbff &&
      firstCode >= 0xdc00 &&
      firstCode <= 0xdfff
    ) {
      // Joining a split surrogate changes its UTF-8 size from 3 to 4 bytes.
      previous.data += text[0];
      previous.byteLength += 1;
      this.byteLength += 1;
      this.lastCodeUnit = firstCode;
      offset = 1;
      this.trim();
    }

    while (offset < text.length) {
      let end = Math.min(offset + MAX_HISTORY_CHUNK_LENGTH, text.length);
      const before = text.charCodeAt(end - 1);
      const after = text.charCodeAt(end);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
        end -= 1;
      }
      const data = text.slice(offset, end);
      // Detach small chunks from large input strings so evicted prefixes can be collected.
      this.appendChunk(
        text.length > MAX_HISTORY_CHUNK_LENGTH
          ? Buffer.from(data, "utf16le").toString("utf16le")
          : data,
      );
      this.trim();
      offset = end;
    }
  }

  private appendChunk(data: string): void {
    const byteLength = Buffer.byteLength(data);
    let lineBreaks = 0;
    for (let index = data.indexOf("\n"); index !== -1; index = data.indexOf("\n", index + 1)) {
      lineBreaks += 1;
    }
    const previous = this.chunks.at(-1);
    if (previous && previous.data.length + data.length <= MAX_HISTORY_CHUNK_LENGTH) {
      previous.data += data;
      previous.byteLength += byteLength;
      previous.lineBreaks += lineBreaks;
    } else {
      this.chunks.push({ data, byteLength, lineBreaks });
    }
    this.byteLength += byteLength;
    this.lineBreaks += lineBreaks;
    this.lastCodeUnit = data.charCodeAt(data.length - 1);
    this.cachedValue = null;
  }

  private discardChunk(): void {
    const first = this.chunks[this.start]!;
    this.byteLength -= first.byteLength;
    this.lineBreaks -= first.lineBreaks;
    this.chunks[this.start++] = undefined;
  }

  private trimChunk(offset: number, byteLength: number, lineBreaks: number): void {
    const first = this.chunks[this.start]!;
    if (offset === first.data.length) {
      this.discardChunk();
      return;
    }
    first.data = first.data.slice(offset);
    first.byteLength -= byteLength;
    first.lineBreaks -= lineBreaks;
    this.byteLength -= byteLength;
    this.lineBreaks -= lineBreaks;
  }

  private trim(): void {
    const trailingNewline = this.lastCodeUnit === 10;
    let linesToDrop = this.lineBreaks + (trailingNewline ? 0 : 1) - this.maxLines;
    while (linesToDrop > 0) {
      const first = this.chunks[this.start]!;
      if (first.lineBreaks < linesToDrop) {
        linesToDrop -= first.lineBreaks;
        this.discardChunk();
        continue;
      }
      let offset = 0;
      for (let line = 0; line < linesToDrop; line += 1) {
        offset = first.data.indexOf("\n", offset) + 1;
      }
      this.trimChunk(offset, Buffer.byteLength(first.data.slice(0, offset)), linesToDrop);
      linesToDrop = 0;
    }

    while (this.byteLength > this.maxBytes) {
      const first = this.chunks[this.start]!;
      const bytesToDrop = this.byteLength - this.maxBytes;
      if (first.byteLength <= bytesToDrop) {
        this.discardChunk();
        continue;
      }
      if (first.byteLength === first.data.length && first.lineBreaks === 0) {
        this.trimChunk(bytesToDrop, bytesToDrop, 0);
        continue;
      }
      let offset = 0;
      let bytes = 0;
      let lineBreaks = 0;
      while (bytes < bytesToDrop) {
        const codePoint = first.data.codePointAt(offset)!;
        bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
        offset += codePoint <= 0xffff ? 1 : 2;
        if (codePoint === 10) lineBreaks += 1;
      }
      this.trimChunk(offset, bytes, lineBreaks);
    }
    if (
      this.start === this.chunks.length ||
      (this.start > 2_048 && this.start * 2 >= this.chunks.length)
    ) {
      this.chunks = this.chunks.slice(this.start);
      this.start = 0;
      if (this.chunks.length === 0) this.lastCodeUnit = undefined;
    }
  }

  clear(): void {
    this.chunks = [];
    this.start = 0;
    this.byteLength = 0;
    this.lineBreaks = 0;
    this.lastCodeUnit = undefined;
    this.cachedValue = "";
  }

  value(): string {
    if (this.cachedValue !== null) return this.cachedValue;
    this.cachedValue = this.chunks
      .slice(this.start)
      .map((chunk) => chunk!.data)
      .join("");
    return this.cachedValue;
  }
}

// Pop beyond Ghostty's eight-entry Kitty stacks on both screens before clearing
// flags. A 1049 round trip preserves the main cursor, text, and scrollback.
const INHERITED_INPUT_RESET =
  "\u001b[?1049h\u001b[<100u\u001b[=0;1u\u001b[?1049l" +
  "\u001b[?1;9;66;67;1000;1002;1003;1004;1005;1006;1015;2004l" +
  "\u001b[?25;1035;1036h\u001b[<100u\u001b[=0;1u\u001b[>4m";

function neutralizeInheritedHistory(history: string, maxLines: number, maxBytes: number): string {
  // Scan exactly the cold replay window, reserving the entire longest reset so
  // neither the server nor the client can trim away the entry after we choose its exit.
  const resetBytes = history.includes("\u001b")
    ? Buffer.byteLength(INHERITED_INPUT_RESET + "\u001b7\u001b[?1049l")
    : 0;
  history = new BoundedTerminalHistory(
    // The suffix occupies the empty line after a trailing newline, too.
    resetBytes > 0 && history.endsWith("\n") ? maxLines - 1 : maxLines,
    history,
    Math.max(0, maxBytes - resetBytes),
  ).value();
  if (!history.includes("\u001b")) return history;
  // An unconditional 1049 reset restores a stale saved cursor on the main
  // screen. The exit must match the inherited screen's cursor-save behavior.
  let alternateScreen: number | undefined;
  // eslint-disable-next-line no-control-regex -- Match replayed alternate-screen controls.
  for (const match of history.matchAll(/\u001b(?:\[\?([0-9;]+)([hl])|(c))/gu)) {
    if (match[3]) alternateScreen = undefined;
    for (const parameter of (match[1] ?? "").split(";")) {
      const mode = Number(parameter);
      if (mode === 47 || mode === 1047 || mode === 1049) {
        alternateScreen = match[2] === "h" ? (alternateScreen ?? mode) : undefined;
      }
    }
  }
  // A client may trim away the entry, leaving us on main: save its current
  // cursor before exiting. On alternate this saves only the alternate cursor.
  const leaveAlternateScreen =
    alternateScreen === undefined ? "" : `\u001b7\u001b[?${alternateScreen}l`;
  return history + leaveAlternateScreen + INHERITED_INPUT_RESET;
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
  // Strip DECRQM/DECRPM query traffic to prevent echoed replies during replay; $ guards preserve setters.
  if ((finalByte === "p" || finalByte === "y") && /^[0-9;?]*\$$/.test(body)) {
    return true;
  }
  // XTVERSION query (>q). DECSCUSR (space-intermediate q) stays.
  if (finalByte === "q" && /^>[0-9;]*$/.test(body)) {
    return true;
  }
  // Kitty keyboard protocol query/reply (?u). Restore-cursor (bare u) stays.
  if (finalByte === "u" && body.startsWith("?")) {
    return true;
  }
  return false;
}

// Strip DECRQSS/XTGETTCAP query traffic; replaying queries triggers fresh replies without visual value.
function shouldStripDcsSequence(content: string): boolean {
  return /^[01]?[$+][qr]/.test(content);
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

// eslint-disable-next-line no-control-regex -- Terminal sequence introducers must reach the parser.
const HISTORY_SEQUENCE_START = /[\u001b\u0090\u009b\u009d\u009e\u009f]/;
const NEXT_HISTORY_SEQUENCE_START = new RegExp(HISTORY_SEQUENCE_START.source, "g");

function sanitizeTerminalHistoryChunk(
  pendingControlSequence: string,
  data: string,
): { visibleText: string; pendingControlSequence: string } {
  if (pendingControlSequence.length === 0 && !HISTORY_SEQUENCE_START.test(data)) {
    return { visibleText: data, pendingControlSequence: "" };
  }

  const input = `${pendingControlSequence}${data}`;
  // Only the pending prefix's final ESC can begin a terminator split across chunks.
  const pendingScanStart = Math.max(0, pendingControlSequence.length - 1);
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
        const terminatorIndex = findStringTerminatorIndex(
          input,
          Math.max(index + 2, pendingScanStart),
        );
        if (terminatorIndex === null) {
          return { visibleText, pendingControlSequence: input.slice(index) };
        }
        const sequence = input.slice(index, terminatorIndex);
        const content = stripStringTerminator(input.slice(index + 2, terminatorIndex));
        const strip =
          (nextCodePoint === 0x5d && shouldStripOscSequence(content)) ||
          (nextCodePoint === 0x50 && shouldStripDcsSequence(content));
        if (!strip) {
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
      const terminatorIndex = findStringTerminatorIndex(
        input,
        Math.max(index + 1, pendingScanStart),
      );
      if (terminatorIndex === null) {
        return { visibleText, pendingControlSequence: input.slice(index) };
      }
      const sequence = input.slice(index, terminatorIndex);
      const content = stripStringTerminator(input.slice(index + 1, terminatorIndex));
      const strip =
        (codePoint === 0x9d && shouldStripOscSequence(content)) ||
        (codePoint === 0x90 && shouldStripDcsSequence(content));
      if (!strip) {
        append(sequence);
      }
      index = terminatorIndex;
      continue;
    }

    // One slice per printable run: every chunk of coloured output reaches this loop.
    NEXT_HISTORY_SEQUENCE_START.lastIndex = index + 1;
    const nextSequenceStart = NEXT_HISTORY_SEQUENCE_START.exec(input)?.index ?? input.length;
    append(input.slice(index, nextSequenceStart));
    index = nextSequenceStart;
  }

  return { visibleText, pendingControlSequence: "" };
}

function legacySafeWorkspaceId(workspaceId: string): string {
  return workspaceId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

const MAX_FILE_NAME_BYTES = 255;

function encodedHistoryWorkspacePart(workspaceId: string): string {
  return `terminal_${Base64Url.encode(workspaceId)}`;
}

function hashId(id: string): string {
  return NodeCrypto.createHash("sha256").update(id).digest("base64url");
}

// "." is outside the base64url alphabet, so a hashed name can never collide with an encoded one.
function hashedHistoryWorkspacePart(workspaceId: string): string {
  return `terminal_sha256.${hashId(workspaceId)}`;
}

function joinHistoryFileName(threadPart: string, terminalPart: string | null): string {
  return terminalPart === null ? `${threadPart}.log` : `${threadPart}_${terminalPart}.log`;
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

const APPIMAGE_RUNTIME_ENV_KEYS = ["APPIMAGE", "APPDIR", "ARGV0", "OWD"] as const;
const APPIMAGE_PATH_LIKE_ENV_KEYS = [
  "PATH",
  "LD_LIBRARY_PATH",
  "XDG_DATA_DIRS",
  "GSETTINGS_SCHEMA_DIR",
] as const;

function isPathSegmentUnderAppDir(segment: string, appDir: string): boolean {
  return segment === appDir || segment.startsWith(`${appDir}/`);
}

// AppImage mount paths would make PTY tools resolve against the mount instead of the user's system.
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
  runtimeEnv: Record<string, string> | null | undefined,
  platform: NodeJS.Platform,
  home: string,
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (shouldExcludeTerminalEnvKey(key)) continue;
    spawnEnv[key] = value;
  }
  if (runtimeEnv) {
    for (const [key, value] of Object.entries(runtimeEnv)) {
      const existingKey =
        platform === "win32"
          ? Object.keys(spawnEnv).find((candidate) => candidate.toLowerCase() === key.toLowerCase())
          : undefined;
      spawnEnv[existingKey ?? key] =
        key === "CODEX_HOME" || key === "CLAUDE_CONFIG_DIR" ? expandHomePath(value, home) : value;
    }
  }
  if (!spawnEnv.COLORTERM && runtimeEnv?.COLORTERM === undefined) {
    spawnEnv.COLORTERM = "truecolor";
  }
  // fish 4.1+ can wait 10s at startup for a DA1 reply before a renderer can answer.
  // Skip the query unless the user or provider already chose `query-term` or `no-query-term`.
  const fishFeaturesKey =
    platform === "win32"
      ? (Object.keys(spawnEnv).find((candidate) => candidate.toLowerCase() === "fish_features") ??
        "fish_features")
      : "fish_features";
  const fishFeatures = spawnEnv[fishFeaturesKey];
  if (!fishFeatures?.includes("query-term")) {
    spawnEnv[fishFeaturesKey] = fishFeatures ? `${fishFeatures},no-query-term` : "no-query-term";
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
  historyByteLimit?: number;
  ptyAdapter: PtyAdapter.PtyAdapter["Service"];
  shellResolver?: () => string;
  env?: NodeJS.ProcessEnv;
  managedBinaryCacheDir?: string;
  managedBinaryToolsDir?: string;
  subprocessInspector?: TerminalSubprocessInspector;
  processTable?: Effect.Effect<
    ReadonlyArray<ResourceMonitorProcessTableEntry>,
    TerminalSubprocessCheckError
  >;
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
  resolveProviderInstanceEnvironment?: (
    providerInstanceId: string,
    env: Record<string, string> | undefined,
  ) => Effect.Effect<
    Record<string, string>,
    TerminalProviderInstanceNotFoundError | TerminalProviderEnvironmentError
  >;
}

export const resolveProviderInstanceTerminalEnvironment = Effect.fn(
  "terminal.resolveProviderInstanceTerminalEnvironment",
)(function* (input: {
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
  readonly path: Path.Path;
  readonly rawProviderInstanceId: string;
  readonly env: Record<string, string> | undefined;
}) {
  const providerInstanceId = ProviderInstanceId.make(input.rawProviderInstanceId);
  const settings = yield* input.serverSettings.getSettings.pipe(
    Effect.mapError((cause) => new TerminalProviderEnvironmentError({ providerInstanceId, cause })),
  );
  const instance = deriveProviderInstanceConfigMap(settings)[providerInstanceId];
  if (instance === undefined) {
    return yield* new TerminalProviderInstanceNotFoundError({ providerInstanceId });
  }

  let resolved = yield* mergeProviderInstanceEnvironment(instance.environment, input.env ?? {});
  if (instance.driver === "codex") {
    const config = decodeCodexSettings(instance.config ?? {});
    if (Option.isSome(config)) {
      const layout = yield* resolveCodexHomeLayout(config.value).pipe(
        Effect.provideService(Path.Path, input.path),
      );
      if (layout.effectiveHomePath)
        resolved = { ...resolved, CODEX_HOME: layout.effectiveHomePath };
    }
  } else if (instance.driver === "claudeAgent") {
    const config = decodeClaudeSettings(instance.config ?? {});
    if (Option.isSome(config)) {
      resolved = yield* makeClaudeEnvironment(config.value, resolved).pipe(
        Effect.provideService(Path.Path, input.path),
      );
    }
  }

  return Object.fromEntries(
    Object.entries(resolved).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
});

/** @public */
export const make = Effect.fn("TerminalManager.make")(function* () {
  const { terminalLogsDir, providerStatusCacheDir, baseDir } = yield* ServerConfig.ServerConfig;
  const ptyAdapter = yield* PtyAdapter.PtyAdapter;
  const portDiscovery = yield* PortScanner.PortDiscovery;
  const nativeTelemetry = yield* NativeTelemetryClient.NativeTelemetryClient;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const resolveProviderInstanceEnvironment = Effect.fn(
    "terminal.resolveProviderInstanceEnvironment",
  )((rawProviderInstanceId: string, env: Record<string, string> | undefined) =>
    resolveProviderInstanceTerminalEnvironment({
      serverSettings,
      path,
      rawProviderInstanceId,
      env,
    }),
  );
  return yield* makeWithOptions({
    logsDir: terminalLogsDir,
    ptyAdapter,
    processTable: nativeTelemetry.processTable.pipe(
      Effect.mapError(
        (cause) => new TerminalSubprocessCheckError({ cause, command: "resource-monitor" }),
      ),
    ),
    managedBinaryCacheDir: providerStatusCacheDir,
    managedBinaryToolsDir: path.join(baseDir, "tools"),
    registerTerminalProcesses: portDiscovery.registerTerminalProcesses,
    unregisterTerminal: portDiscovery.unregisterTerminal,
    resolveProviderInstanceEnvironment,
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
  const historyByteLimit = options.historyByteLimit ?? DEFAULT_HISTORY_BYTE_LIMIT;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const agentScope = yield* AgentScope;
  // Inherit the full environment minus createTerminalSpawnEnv's blocklist; allowlists silently drop user tooling variables.
  const baseEnv = options.env ?? process.env;
  const shellResolver = options.shellResolver ?? (() => defaultShellResolver(platform, baseEnv));
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const resolveLaunchInputEnvironment = Effect.fn("terminal.resolveLaunchInputEnvironment")(
    function* <Input extends TerminalOpenInput | TerminalAttachInput | TerminalRestartInput>(
      input: Input,
    ): Effect.fn.Return<
      Input,
      TerminalProviderInstanceNotFoundError | TerminalProviderEnvironmentError
    > {
      if (input.providerInstanceId === undefined) return input;
      const resolver = options.resolveProviderInstanceEnvironment;
      if (resolver === undefined) {
        return yield* new TerminalProviderInstanceNotFoundError({
          providerInstanceId: ProviderInstanceId.make(input.providerInstanceId),
        });
      }
      const env = yield* resolver(input.providerInstanceId, input.env);
      return { ...input, env };
    },
  );
  // Share one process table per poll; per-terminal scans can exhaust PIDs on busy hosts.
  const fallbackProcessTableSnapshot = (
    platform === "win32"
      ? windowsProcessTableSnapshot()
      : posixProcessTableSnapshot(yield* resolvePosixPsCommand())
  ).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner));
  const fetchProcessTableSnapshot: Effect.Effect<
    {
      readonly snapshot: TerminalProcessTableSnapshot;
      readonly snapshotSucceeded: boolean;
    },
    TerminalSubprocessCheckError
  > = options.processTable
    ? options.processTable.pipe(
        Effect.map((entries) => ({
          snapshot: processTableSnapshotFromProcesses(entries),
          snapshotSucceeded: true,
        })),
        Effect.catch(() =>
          fallbackProcessTableSnapshot.pipe(
            Effect.map((snapshot) => ({ snapshot, snapshotSucceeded: false })),
          ),
        ),
      )
    : fallbackProcessTableSnapshot.pipe(
        Effect.map((snapshot) => ({ snapshot, snapshotSucceeded: true })),
      );
  const customSubprocessInspector = options.subprocessInspector;
  const acquireSubprocessInspector: Effect.Effect<
    {
      readonly inspector: TerminalSubprocessInspector;
      readonly snapshotSucceeded: boolean;
    },
    TerminalSubprocessCheckError
  > =
    customSubprocessInspector !== undefined
      ? Effect.succeed({ inspector: customSubprocessInspector, snapshotSucceeded: true })
      : Effect.map(
          fetchProcessTableSnapshot,
          ({
            snapshot,
            snapshotSucceeded,
          }): {
            readonly inspector: TerminalSubprocessInspector;
            readonly snapshotSucceeded: boolean;
          } => ({
            inspector: (terminalPid) =>
              Effect.succeed(deriveSubprocessInspectResult(snapshot, terminalPid, platform)),
            snapshotSucceeded,
          }),
        );
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
  const workspaceLocks = yield* KeyedLock.make<string>();
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
    if (workspaceId === PROVIDER_SETUP_TERMINAL_WORKSPACE_ID) return;
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

  const publishEvent =
    /* Provider events include streaming deltas; avoid a span for each update. */
    Effect.fnUntraced(function* (event: TerminalEvent) {
      if (shouldPublishTerminalMetadataEvent(event)) {
        const state = yield* SynchronizedRef.get(managerStateRef);
        const session = state.sessions.get(toSessionKey(event.workspaceId, event.terminalId));
        if (session) yield* persistSessionMetadata(session);
      }
      for (const listener of terminalEventListeners) {
        yield* listener(event).pipe(Effect.ignoreCause({ log: true }));
      }
    });

  // Nested subagent thread ids can encode past the filename limit. Only names that would not fit
  // switch to hashed ids, so every history file that already exists keeps its path.
  const historyPath = (workspaceId: string, terminalId: string) => {
    const isDefault = terminalId === DEFAULT_TERMINAL_ID;
    const encodedName = joinHistoryFileName(
      encodedHistoryWorkspacePart(workspaceId),
      isDefault ? null : Base64Url.encode(terminalId),
    );
    if (encodedName.length <= MAX_FILE_NAME_BYTES) {
      return path.join(logsDir, encodedName);
    }
    return path.join(
      logsDir,
      joinHistoryFileName(
        hashedHistoryWorkspacePart(workspaceId),
        isDefault ? null : hashId(terminalId),
      ),
    );
  };

  const legacyHistoryName = (workspaceId: string) => `${legacySafeWorkspaceId(workspaceId)}.log`;
  const legacyHistoryPath = (workspaceId: string) =>
    path.join(logsDir, legacyHistoryName(workspaceId));
  // Ids this long could never have been written under the legacy name.
  const hasLegacyHistoryPath = (workspaceId: string) =>
    Buffer.byteLength(legacyHistoryName(workspaceId)) <= MAX_FILE_NAME_BYTES;

  const readManagerState = SynchronizedRef.get(managerStateRef);

  const modifyManagerState = <A>(
    f: (state: TerminalManagerState) => readonly [A, TerminalManagerState],
  ) => SynchronizedRef.modify(managerStateRef, f);

  const withWorkspaceLock = <A, E, R>(
    workspaceId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => workspaceLocks.withLock(workspaceId, effect);

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
      // Children may finalize before registration; check inside the synchronized update to avoid retaining finished fibers.
      if (fiber.pollUnsafe() !== undefined) {
        return [undefined, state] as const;
      }
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
    // Subscribe before SIGTERM to catch immediate exits; Effect.ensuring releases even on interruption, unlike JS finally.
    const exited = Deferred.makeUnsafe<void>();
    const unsubscribeExit = process.onExit(() => {
      Deferred.doneUnsafe(exited, Effect.void);
    });
    yield* Effect.gen(function* () {
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

      const exitedBeforeGrace = yield* Deferred.await(exited).pipe(
        Effect.as(true),
        Effect.timeoutOrElse({
          duration: processKillGraceMs,
          orElse: () => Effect.succeed(false),
        }),
      );
      if (exitedBeforeGrace) {
        return;
      }

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
    }).pipe(Effect.ensuring(Effect.sync(unsubscribeExit)));
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

  const pendingHistories = new Map<string, PersistHistoryRequest>();
  let historyRevision = 0;
  const persistenceScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(persistenceScope, Exit.void));
  const persistWorker = yield* makeKeyedCoalescingWorker<
    string,
    PersistHistoryRequest,
    never,
    never
  >({
    merge: (current, next) => ({
      ...next,
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

      yield* fileSystem
        .writeFileString(historyPath(workspaceId, terminalId), request.history.value())
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (pendingHistories.get(sessionKey)?.revision === request.revision)
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
    history: BoundedTerminalHistory,
  ) {
    const request = { history, immediate: false, revision: ++historyRevision };
    pendingHistories.set(toSessionKey(workspaceId, terminalId), request);
    yield* persistWorker.enqueue(toSessionKey(workspaceId, terminalId), request);
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
    history: BoundedTerminalHistory,
  ) {
    const request = { history, immediate: true, revision: ++historyRevision };
    pendingHistories.set(toSessionKey(workspaceId, terminalId), request);
    yield* persistWorker.enqueue(toSessionKey(workspaceId, terminalId), request);
    yield* flushPersist(workspaceId, terminalId);
  });

  const readHistoryTail = Effect.fn("terminal.readHistoryTail")(function* (filePath: string) {
    const file = yield* fileSystem.open(filePath, { flag: "r" });
    const info = yield* file.stat;
    const limit = BigInt(historyByteLimit);
    const offset = info.size > limit ? info.size - limit : 0n;
    yield* file.seek(offset, "start");
    const bytes = new Uint8Array(Number(info.size - offset));
    let length = 0;
    while (length < bytes.length) {
      const read = Number(yield* file.read(bytes.subarray(length)));
      if (read === 0) break;
      length += read;
    }
    let start = 0;
    if (offset > 0n) {
      // A tail read can start inside a UTF-8 code point. Skip its remaining bytes.
      while (start < length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
    }
    return {
      history: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(start, length)),
      truncated: offset > 0n,
    };
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
      const { history: raw, truncated } = yield* readHistoryTail(nextPath).pipe(
        Effect.scoped,
        Effect.mapError(
          (cause) =>
            new TerminalHistoryError({ operation: "read", workspaceId, terminalId, cause }),
        ),
      );
      const history = new BoundedTerminalHistory(historyLineLimit, raw, historyByteLimit);
      const capped = history.value();
      if (truncated || capped !== raw) {
        yield* fileSystem
          .writeFileString(nextPath, capped)
          .pipe(
            Effect.mapError(
              (cause) =>
                new TerminalHistoryError({ operation: "truncate", workspaceId, terminalId, cause }),
            ),
          );
      }
      return history;
    }

    if (terminalId !== DEFAULT_TERMINAL_ID || !hasLegacyHistoryPath(workspaceId)) {
      return new BoundedTerminalHistory(historyLineLimit, "", historyByteLimit);
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
      return new BoundedTerminalHistory(historyLineLimit, "", historyByteLimit);
    }

    const { history: raw } = yield* readHistoryTail(legacyPath).pipe(
      Effect.scoped,
      Effect.mapError(
        (cause) =>
          new TerminalHistoryError({ operation: "migrate", workspaceId, terminalId, cause }),
      ),
    );
    const history = new BoundedTerminalHistory(historyLineLimit, raw, historyByteLimit);
    const capped = history.value();
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
    return history;
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
    if (terminalId === DEFAULT_TERMINAL_ID && hasLegacyHistoryPath(workspaceId)) {
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
      const threadParts = [
        encodedHistoryWorkspacePart(workspaceId),
        hashedHistoryWorkspacePart(workspaceId),
      ];
      const entries = yield* fileSystem
        .readDirectory(logsDir, { recursive: false })
        .pipe(Effect.orElseSucceed(() => [] as Array<string>));
      yield* Effect.forEach(
        entries.filter(
          (name) =>
            name === `${legacySafeWorkspaceId(workspaceId)}.log` ||
            threadParts.some((part) => name === `${part}.log` || name.startsWith(`${part}_`)),
        ),
        (name) =>
          fileSystem.remove(path.join(logsDir, name), { force: true }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to delete terminal histories for thread", {
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
      inputCount: 0,
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
      Effect.fromOption(session, () => new TerminalSessionLookupError({ workspaceId, terminalId })),
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
            session.history.append(sanitized.visibleText);
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

    const launch = yield* agentScope.wrap({
      command: candidate.shell,
      args: candidate.args ?? [],
      name: "terminal",
      env: spawnEnv,
      survivesRestart: true,
    });
    const attempt = yield* Effect.result(
      options.ptyAdapter.spawn({
        shell: launch.command,
        ...(launch.args.length > 0 ? { args: [...launch.args] } : {}),
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
            const terminalEnv = createTerminalSpawnEnv(
              baseEnv,
              session.runtimeEnv,
              platform,
              yield* HostProcess.HomeDirectory,
            );
            // Append managed install directories so agent commands resolve without shadowing user/system tools.
            if (
              options.managedBinaryCacheDir !== undefined &&
              options.managedBinaryToolsDir !== undefined
            ) {
              const managedDirectories = yield* acpRegistryManagedBinaryDirectories({
                cacheDir: options.managedBinaryCacheDir,
                toolsDir: options.managedBinaryToolsDir,
                platform,
                architecture,
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
              );
              if (managedDirectories.length > 0) {
                const delimiter = platform === "win32" ? ";" : ":";
                const pathKey =
                  platform === "win32"
                    ? (Object.keys(terminalEnv).find(
                        (candidate) => candidate.toLowerCase() === "path",
                      ) ?? "PATH")
                    : "PATH";
                const merged = mergePathEntries(
                  terminalEnv[pathKey],
                  managedDirectories.join(delimiter),
                  platform,
                );
                if (merged !== undefined) {
                  terminalEnv[pathKey] = merged;
                }
              }
            }
            const spawnResult = yield* trySpawn(shellCandidates, terminalEnv, session);
            ptyProcess = spawnResult.process;
            startedShell = spawnResult.shellLabel;

            const processPid = ptyProcess.pid;
            let eventsActivated = false;

            let eventStamp: ReturnType<typeof advanceEventSequence> = {
              updatedAt: session.updatedAt,
              sequence: session.eventSequence,
            };
            yield* modifyManagerState((state) => {
              session.process = ptyProcess;
              session.pid = processPid;
              session.status = "running";
              // onExit may replay an exit immediately; accept it before subscribing.
              session.unsubscribeData = spawnResult.process.onData((data) => {
                if (!enqueueProcessEvent(session, processPid, { type: "output", data })) {
                  return;
                }
                if (eventsActivated) runFork(drainProcessEvents(session, processPid));
              });
              session.unsubscribeExit = spawnResult.process.onExit((event) => {
                if (!enqueueProcessEvent(session, processPid, { type: "exit", event })) {
                  return;
                }
                if (eventsActivated) runFork(drainProcessEvents(session, processPid));
              });
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
            // Publish startup before draining any events replayed during subscription.
            eventsActivated = true;
            if (session.processEventDrainRunning) runFork(drainProcessEvents(session, processPid));
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
      if (Option.isSome(session)) session.value.history.clear();
      yield* deleteHistory(workspaceId, terminalId);
    }
  });

  // Two unchanged snapshots cover children forked just after the first snapshot.
  // Process identity prevents a restarted shell from inheriting quiet state.
  let quietSessions = new WeakMap<TerminalSessionState, QuietTerminalSession>();
  let skippedQuietTicks = 0;
  const isQuiet = (session: TerminalSessionState & { pid: number }) => {
    const quiet = quietSessions.get(session);
    return (
      quiet !== undefined &&
      quiet.idleSnapshots === 2 &&
      quiet.process === session.process &&
      quiet.mark === terminalActivityMark(session) &&
      !session.hasRunningSubprocess
    );
  };

  const pollSubprocessActivity = Effect.fn("terminal.pollSubprocessActivity")(function* () {
    const state = yield* readManagerState;
    const runningSessions = [...state.sessions.values()]
      .filter(
        (session): session is TerminalSessionState & { pid: number } =>
          session.status === "running" && Number.isInteger(session.pid),
      )
      .map((session) => ({
        session,
        terminalPid: session.pid,
        process: session.process,
        mark: terminalActivityMark(session),
      }));

    if (runningSessions.length === 0) {
      return true;
    }
    if (
      runningSessions.every(({ session }) => isQuiet(session)) &&
      skippedQuietTicks < QUIET_SUBPROCESS_SNAPSHOT_EVERY_TICKS - 1
    ) {
      skippedQuietTicks += 1;
      return true;
    }
    skippedQuietTicks = 0;

    const inspectorOption = yield* acquireSubprocessInspector.pipe(
      Effect.asSome,
      Effect.catch((reason) =>
        Effect.logWarning("failed to snapshot processes for terminal subprocess polling", {
          reason,
        }).pipe(
          Effect.as(
            Option.none<{
              readonly inspector: TerminalSubprocessInspector;
              readonly snapshotSucceeded: boolean;
            }>(),
          ),
        ),
      ),
    );

    if (Option.isNone(inspectorOption)) {
      quietSessions = new WeakMap();
      return false;
    }

    const { inspector: subprocessInspector, snapshotSucceeded } = inspectorOption.value;
    const checkSubprocessActivity = Effect.fn("terminal.checkSubprocessActivity")(function* (
      candidate: (typeof runningSessions)[number],
    ) {
      const { session, terminalPid, process } = candidate;
      let mark = candidate.mark;
      const previous = quietSessions.get(session);
      quietSessions.delete(session);
      const inspectResult = yield* subprocessInspector(terminalPid).pipe(
        Effect.asSome,
        Effect.catch((reason) =>
          Effect.logWarning("failed to check terminal subprocess activity", {
            workspaceId: session.workspaceId,
            terminalId: session.terminalId,
            terminalPid,
            reason,
          }).pipe(Effect.as(Option.none<TerminalSubprocessInspectResult>())),
        ),
      );

      if (
        Option.isNone(inspectResult) ||
        session.status !== "running" ||
        session.pid !== terminalPid ||
        session.process !== process
      ) {
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
          liveSession.value !== session ||
          liveSession.value.status !== "running" ||
          liveSession.value.pid !== terminalPid ||
          liveSession.value.process !== process ||
          (liveSession.value.hasRunningSubprocess === next.hasRunningSubprocess &&
            liveSession.value.childCommandLabel === nextChildLabel)
        ) {
          return [Option.none(), state] as const;
        }

        liveSession.value.hasRunningSubprocess = next.hasRunningSubprocess;
        liveSession.value.childCommandLabel = nextChildLabel;
        const eventStamp = advanceEventSequence(liveSession.value);
        // Only this poll's own event may advance the mark without waking it.
        mark += 1;

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

      if (
        snapshotSucceeded &&
        !next.hasRunningSubprocess &&
        session.status === "running" &&
        session.pid === terminalPid &&
        session.process === process &&
        terminalActivityMark(session) === mark
      ) {
        quietSessions.set(session, {
          process,
          mark,
          idleSnapshots: previous?.process === process && previous.mark === mark ? 2 : 1,
        });
      }
    });

    yield* Effect.forEach(runningSessions, checkSubprocessActivity, {
      concurrency: "unbounded",
      discard: true,
    });

    return snapshotSucceeded;
  });

  const hasRunningSessions = readManagerState.pipe(
    Effect.map((state) =>
      [...state.sessions.values()].some((session) => session.status === "running"),
    ),
  );

  let subprocessSnapshotFailureCount = 0;
  yield* Effect.forever(
    hasRunningSessions.pipe(
      Effect.flatMap((active) =>
        active
          ? pollSubprocessActivity().pipe(
              Effect.flatMap((snapshotSucceeded) => {
                subprocessSnapshotFailureCount = snapshotSucceeded
                  ? 0
                  : Math.min(subprocessSnapshotFailureCount + 1, 30);
                const delayMs = subprocessSnapshotPollDelayMs(
                  subprocessPollIntervalMs,
                  subprocessSnapshotFailureCount,
                );
                return Effect.sleep(delayMs);
              }),
            )
          : Effect.sync(() => {
              subprocessSnapshotFailureCount = 0;
            }).pipe(Effect.flatMap(() => Effect.sleep(subprocessPollIntervalMs))),
      ),
    ),
  ).pipe(Effect.forkIn(workerScope));

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Scope.close(persistenceScope, Exit.void);
      yield* Effect.forEach(
        pendingHistories,
        ([key, { history }]) => {
          const [workspaceId, terminalId] = key.split("\u0000");
          return workspaceId && terminalId
            ? fileSystem
                .writeFileString(historyPath(workspaceId, terminalId), history.value())
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
          .writeFileString(
            historyPath(session.workspaceId, session.terminalId),
            session.history.value(),
          )
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

  const openWithWorkspaceLease = Effect.fn("terminal.openLocked")(function* (
    input: TerminalOpenInput,
  ) {
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
      const inherited = yield* readHistory(input.workspaceId, terminalId);
      const history = new BoundedTerminalHistory(
        historyLineLimit,
        neutralizeInheritedHistory(
          inherited.value(),
          historyLineLimit,
          Math.min(historyByteLimit, DEFAULT_MAX_TERMINAL_BUFFER_BYTES),
        ),
        historyByteLimit,
      );
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
        inputCount: 0,
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

  const openLocked = (input: TerminalOpenInput) =>
    withWorkspaceLease(
      path.resolve(input.worktreePath ?? input.cwd),
      resolveLaunchInputEnvironment(input).pipe(
        Effect.flatMap(openWithWorkspaceLease),
        Effect.uninterruptible,
      ),
    );

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

  const openOrAttachForStream = Effect.fn("terminal.attachSnapshot")(function* (
    input: TerminalAttachInput,
  ) {
    const session = yield* restoreSession(input.workspaceId, input.terminalId);
    if (Option.isNone(session))
      return yield* new TerminalSessionLookupError({
        workspaceId: input.workspaceId,
        terminalId: input.terminalId,
      });
    return snapshot(session.value);
  });

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

  const subscribe: TerminalManager["Service"]["subscribe"] = (listener, registerCleanup) =>
    Effect.sync(() => {
      terminalEventListeners.add(listener);
      const stop = () => {
        terminalEventListeners.delete(listener);
      };
      // Transfer ownership before an interrupt can discard the returned handle.
      registerCleanup?.(stop);
      return stop;
    });

  // Subscribe after taking the lock so contention cannot accumulate an unbounded replay.
  // Snapshot listeners run under that lock and must not block.
  const streamSession = (
    input: TerminalObserveInput,
    initial: Effect.Effect<TerminalSessionSnapshot | null, TerminalError>,
    listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
    registerCleanup?: (stop: () => void) => void,
  ) => {
    let unsubscribe: (() => void) | null = null;
    const stop = () => {
      unsubscribe?.();
      unsubscribe = null;
    };

    return Effect.gen(function* () {
      const bufferedEvents: TerminalEvent[] = [];
      let deliverLive = false;
      let snapshotFloor: number | null = null;

      yield* subscribe(
        (event) => {
          if (event.workspaceId !== input.workspaceId || event.terminalId !== input.terminalId) {
            return Effect.void;
          }

          if (!deliverLive) {
            bufferedEvents.push(event);
            return Effect.void;
          }

          // Fanout can finish after a snapshot that already includes the event.
          // Keep only its sequence, not its history, until the session changes.
          if (snapshotFloor !== null) {
            if (
              event.type === "started" ||
              event.type === "restarted" ||
              event.type === "error" ||
              event.type === "closed"
            ) {
              snapshotFloor = null;
            } else if (typeof event.sequence === "number" && event.sequence <= snapshotFloor) {
              return Effect.void;
            }
          }

          const attachEvent = terminalEventToAttachEvent(event);
          return attachEvent ? listener(attachEvent) : Effect.void;
        },
        (cleanup) => {
          unsubscribe = cleanup;
          registerCleanup?.(stop);
        },
      );

      const initialSnapshot = yield* initial;

      yield* listener(
        initialSnapshot === null
          ? { type: "closed", workspaceId: input.workspaceId, terminalId: input.terminalId }
          : { type: "snapshot", snapshot: initialSnapshot },
      );

      for (const event of bufferedEvents) {
        if (initialSnapshot !== null && isDuplicateAttachSnapshotEvent(event, initialSnapshot)) {
          continue;
        }

        const attachEvent = terminalEventToAttachEvent(event);
        if (attachEvent) {
          yield* listener(attachEvent);
        }
      }
      // The live listener keeps this closure, so release replayed output.
      bufferedEvents.length = 0;

      snapshotFloor = initialSnapshot?.sequence ?? null;
      deliverLive = true;
      return stop;
    }).pipe(
      (effect) => withWorkspaceLock(input.workspaceId, effect),
      Effect.onError(() => Effect.sync(stop)),
    );
  };

  const attachStream: TerminalManager["Service"]["attachStream"] = (
    input,
    listener,
    registerCleanup,
  ) => streamSession(input, openOrAttachForStream(input), listener, registerCleanup);

  const observeStream: TerminalManager["Service"]["observeStream"] = (
    input,
    listener,
    registerCleanup,
  ) =>
    streamSession(
      input,
      requireSession(input.workspaceId, input.terminalId).pipe(Effect.map(snapshot)),
      listener,
      registerCleanup,
    );

  const resyncStream: TerminalManager["Service"]["resyncStream"] = (
    input,
    listener,
    registerCleanup,
  ) =>
    streamSession(
      input,
      getSession(input.workspaceId, input.terminalId).pipe(
        Effect.map((session) => (Option.isSome(session) ? snapshot(session.value) : null)),
      ),
      listener,
      registerCleanup,
    );

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
    session.inputCount += 1;
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

  const taskSubmissions = new Map<
    string,
    Deferred.Deferred<TerminalSessionSnapshot, TerminalError>
  >();
  const runTask: TerminalManager["Service"]["runTask"] = Effect.fn("terminal.runTask")(
    function* (input, readiness) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const key = toSessionKey(input.workspaceId, input.terminalId);
          const pending = taskSubmissions.get(key);
          if (pending) {
            const result = yield* restore(Deferred.await(pending));
            if (readiness) yield* readiness.onOpened(result);
            return result;
          }
          const done = Deferred.makeUnsafe<TerminalSessionSnapshot, TerminalError>();
          taskSubmissions.set(key, done);
          return yield* restore(
            Effect.gen(function* () {
              const prepared = yield* checkoutLifecycleLock.withPermit(
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
                      return { submitted: true, snapshot: snapshot(existing.value) };
                    }
                    return { submitted: false, snapshot: yield* openLocked(input) };
                  }),
                ),
              );
              if (readiness) yield* readiness.onOpened(prepared.snapshot);
              if (prepared.submitted) return prepared.snapshot;
              if (readiness) yield* readiness.beforeWrite;
              return yield* withWorkspaceLock(
                input.workspaceId,
                Effect.gen(function* () {
                  yield* writeLocked(
                    {
                      workspaceId: input.workspaceId,
                      terminalId: input.terminalId,
                      generation: prepared.snapshot.generation,
                      data: input.command,
                    },
                    true,
                  );
                  const session = yield* requireSession(input.workspaceId, input.terminalId);
                  session.taskStatus = "submitted";
                  yield* persistSessionMetadata(session);
                  return snapshot(session);
                }).pipe(Effect.uninterruptible),
              );
            }),
          ).pipe(
            Effect.onExit((exit) =>
              Deferred.done(done, exit).pipe(
                Effect.andThen(Effect.sync(() => taskSubmissions.delete(key))),
              ),
            ),
          );
        }),
      );
    },
  );

  const resizeLocked = Effect.fn("terminal.resize")(function* (input: TerminalResizeInput) {
    const session = yield* getSession(input.workspaceId, input.terminalId);
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
        session.history.clear();
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

  const restartResolved = Effect.fn("Manager.restartResolved")(function* (
    input: TerminalRestartInput,
  ) {
    input = {
      ...input,
      cwd: yield* resolvePath(input.cwd),
      ...(input.worktreePath ? { worktreePath: yield* resolvePath(input.worktreePath) } : {}),
    };
    if (invalidatedWorkspaces.has(input.workspaceId))
      return yield* new TerminalWorkspaceError({ message: "This checkout was removed." });
    if (workspaces.has(input.workspaceId)) yield* validateWorkspace(input.workspaceId, input.cwd);
    yield* increment(terminalRestartsTotal, { scope: "workspace" });
    const terminalId = input.terminalId;
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
        history: new BoundedTerminalHistory(historyLineLimit, "", historyByteLimit),
        pendingHistoryControlSequence: "",
        pendingProcessEvents: [],
        pendingProcessEventIndex: 0,
        processEventDrainRunning: false,
        exitCode: null,
        exitSignal: null,
        updatedAt: yield* nowIso,
        eventSequence: 0,
        inputCount: 0,
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

    session.history.clear();
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
  });

  const restart: TerminalManager["Service"]["restart"] = (input) =>
    checkoutLifecycleLock.withPermit(
      withWorkspaceLock(
        input.workspaceId,
        resolveLaunchInputEnvironment(input).pipe(
          Effect.flatMap((resolved) =>
            withWorkspaceLease(
              path.resolve(resolved.worktreePath ?? resolved.cwd),
              restartResolved(resolved).pipe(Effect.uninterruptible),
            ),
          ),
        ),
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

  const closeIdle: TerminalManager["Service"]["closeIdle"] = Effect.fn("terminal.closeIdle")(
    function* (input) {
      const candidates = yield* withWorkspaceLock(
        input.workspaceId,
        sessionsForWorkspace(input.workspaceId).pipe(
          Effect.map((sessions) =>
            sessions
              .filter(
                (session): session is TerminalSessionState & { pid: number } =>
                  session.status === "running" &&
                  Number.isInteger(session.pid) &&
                  (input.terminalId === undefined || session.terminalId === input.terminalId),
              )
              .map((session) => ({
                session,
                pid: session.pid,
                mark: terminalActivityMark(session),
              })),
          ),
        ),
      );
      if (candidates.length === 0) return;
      const { inspector } = yield* acquireSubprocessInspector;
      yield* Effect.forEach(
        candidates,
        ({ session, pid, mark }) =>
          inspector(pid).pipe(
            Effect.flatMap((result) =>
              result.hasRunningSubprocess
                ? Effect.void
                : withWorkspaceLock(
                    input.workspaceId,
                    Effect.gen(function* () {
                      const current = yield* restoreSession(input.workspaceId, session.terminalId);
                      if (
                        Option.isNone(current) ||
                        current.value !== session ||
                        session.pid !== pid ||
                        session.status !== "running" ||
                        terminalActivityMark(session) !== mark
                      )
                        return;
                      yield* closeSession(input.workspaceId, session.terminalId, false);
                    }),
                  ),
            ),
          ),
        { discard: true },
      );
    },
    (effect, input) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to close idle terminals", {
            workspaceId: input.workspaceId,
            error: error.message,
          }),
        ),
      ),
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
          Effect.map((value) =>
            new BoundedTerminalHistory(historyLineLimit, value, historyByteLimit).value(),
          ),
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
    wasRemoved = () => true,
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
        if (!wasRemoved(result)) return result;
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
    observeStream,
    resyncStream,
    write,
    resize,
    clear,
    restart,
    close,
    closeIdle,
    subscribe,
    subscribeMetadata,
  });
});

export const layer = Layer.effect(TerminalManager, make()).pipe(Layer.provide(ProcessRunner.layer));
