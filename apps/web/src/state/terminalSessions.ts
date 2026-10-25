import {
  combineTerminalSessionState,
  EMPTY_TERMINAL_BUFFER_STATE,
  EMPTY_TERMINAL_SESSION_STATE,
  selectRunningSubprocessTerminalIds,
  type KnownTerminalSession,
  type TerminalSessionState,
} from "@t3tools/client-runtime/state/terminal";
import {
  ThreadId,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  type EnvironmentId,
  type TerminalAttachInput,
  type TerminalSummary,
} from "@t3tools/contracts";

import { useEnvironmentQuery } from "./query";
import { terminalEnvironment } from "./terminal";
import { useEnvironmentScope } from "./session";

const EMPTY_KNOWN_TERMINAL_SESSIONS = Object.freeze<ReadonlyArray<KnownTerminalSession>>([]);

interface TerminalMetadataIndex {
  readonly all: ReadonlyArray<TerminalSummary>;
  readonly byWorkspaceId: ReadonlyMap<string, ReadonlyArray<TerminalSummary>>;
  readonly views: Map<EnvironmentId, Map<string | null, ReadonlyArray<KnownTerminalSession>>>;
}

const metadataIndexes = new WeakMap<ReadonlyArray<TerminalSummary>, TerminalMetadataIndex>();
const sessionsBySummary = new WeakMap<TerminalSummary, Map<EnvironmentId, KnownTerminalSession>>();
// Reuse held groups without retaining old members when their anchor survives in newer snapshots.
const groupsByAnchor = new WeakMap<
  TerminalSummary,
  Map<
    EnvironmentId,
    {
      readonly all?: WeakRef<ReadonlyArray<KnownTerminalSession>>;
      readonly thread?: WeakRef<ReadonlyArray<KnownTerminalSession>>;
    }
  >
>();

function knownSession(
  summary: TerminalSummary,
  environmentId: EnvironmentId,
): KnownTerminalSession {
  let byEnvironment = sessionsBySummary.get(summary);
  const previous = byEnvironment?.get(environmentId);
  if (previous) return previous;
  const session = {
    target: {
      environmentId,
      workspaceId: summary.workspaceId,
      terminalId: summary.terminalId,
    },
    state: combineTerminalSessionState(summary, EMPTY_TERMINAL_BUFFER_STATE),
  };
  if (!byEnvironment) {
    byEnvironment = new Map();
    sessionsBySummary.set(summary, byEnvironment);
  }
  byEnvironment.set(environmentId, session);
  return session;
}

function terminalMetadataIndex(metadata: ReadonlyArray<TerminalSummary>): TerminalMetadataIndex {
  let index = metadataIndexes.get(metadata);
  if (!index) {
    const compare = new Intl.Collator(undefined, { numeric: true }).compare;
    const all = metadata.toSorted((left, right) => compare(left.terminalId, right.terminalId));
    const byWorkspaceId = new Map<string, TerminalSummary[]>();
    for (const summary of all) {
      const group = byWorkspaceId.get(summary.workspaceId);
      if (group) group.push(summary);
      else byWorkspaceId.set(summary.workspaceId, [summary]);
    }
    index = { all, byWorkspaceId, views: new Map() };
    metadataIndexes.set(metadata, index);
  }
  return index;
}

export function selectKnownTerminalSessions(
  metadata: ReadonlyArray<TerminalSummary> | null,
  environmentId: EnvironmentId | null,
  workspaceId: string | null,
): ReadonlyArray<KnownTerminalSession> {
  if (environmentId === null || metadata === null || metadata.length === 0) {
    return EMPTY_KNOWN_TERMINAL_SESSIONS;
  }
  const index = terminalMetadataIndex(metadata);
  let views = index.views.get(environmentId);
  const cached = views?.get(workspaceId);
  if (cached) return cached;
  const summaries = workspaceId === null ? index.all : index.byWorkspaceId.get(workspaceId);
  if (!summaries || summaries.length === 0) return EMPTY_KNOWN_TERMINAL_SESSIONS;

  const anchor = summaries[0]!;
  const kind = workspaceId === null ? "all" : "thread";
  let groups = groupsByAnchor.get(anchor);
  const previousGroups = groups?.get(environmentId);
  const previous = previousGroups?.[kind]?.deref();
  const sessions =
    previous?.length === summaries.length &&
    previous.every((session, index) => session.state.summary === summaries[index])
      ? previous
      : summaries.map((summary) => knownSession(summary, environmentId));
  if (!groups) {
    groups = new Map();
    groupsByAnchor.set(anchor, groups);
  }
  if (sessions !== previous) {
    groups.set(environmentId, { ...previousGroups, [kind]: new WeakRef(sessions) });
  }
  if (!views) {
    views = new Map();
    index.views.set(environmentId, views);
  }
  views.set(workspaceId, sessions);
  return sessions;
}
import { useThreadTerminalWorkspace } from "./terminalWorkspace";

export function useAttachedTerminalSession(input: {
  readonly environmentId: EnvironmentId | null;
  readonly terminal: TerminalAttachInput | null;
}): TerminalSessionState {
  const canRead = useEnvironmentScope(input.environmentId, AuthTerminalReadScope);
  const canOperate = useEnvironmentScope(input.environmentId, AuthTerminalOperateScope);
  const attach = useEnvironmentQuery(
    input.environmentId !== null && input.terminal !== null
      ? canOperate
        ? terminalEnvironment.attach({
            environmentId: input.environmentId,
            input: input.terminal,
          })
        : canRead
          ? terminalEnvironment.observe({
              environmentId: input.environmentId,
              input: {
                workspaceId: input.terminal.workspaceId,
                terminalId: input.terminal.terminalId,
              },
            })
          : null
      : null,
  );
  const metadata = useEnvironmentQuery(
    input.environmentId === null || !canRead
      ? null
      : terminalEnvironment.metadata({
          environmentId: input.environmentId,
          input: null,
        }),
  );

  if (input.environmentId === null || input.terminal === null) {
    return EMPTY_TERMINAL_SESSION_STATE;
  }
  const summary =
    (metadata.data === null
      ? null
      : terminalMetadataIndex(metadata.data)
          .byWorkspaceId.get(input.terminal.workspaceId)
          ?.find((terminal) => terminal.terminalId === input.terminal?.terminalId)) ?? null;
  const state = combineTerminalSessionState(summary, attach.data ?? EMPTY_TERMINAL_BUFFER_STATE);
  return attach.error === null ? state : { ...state, error: attach.error, status: "error" };
}

export function useKnownTerminalSessions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId?: ThreadId | null;
  readonly workspaceId?: string | null;
}): ReadonlyArray<KnownTerminalSession> | null {
  const threadWorkspace = useThreadTerminalWorkspace(
    input.environmentId && input.threadId
      ? { environmentId: input.environmentId, threadId: input.threadId }
      : null,
  );
  const workspaceId = input.workspaceId ?? threadWorkspace.data?.id;
  const canRead = useEnvironmentScope(input.environmentId, AuthTerminalReadScope);
  const metadata = useEnvironmentQuery(
    input.environmentId === null || !canRead
      ? null
      : terminalEnvironment.metadata({
          environmentId: input.environmentId,
          input: null,
        }),
  );
  return metadata.data === null || metadata.error !== null
    ? null
    : workspaceId
      ? selectKnownTerminalSessions(metadata.data, input.environmentId, workspaceId)
      : EMPTY_KNOWN_TERMINAL_SESSIONS;
}

export function useThreadRunningTerminalIds(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<string> {
  const sessions = useKnownTerminalSessions(input);
  return selectRunningSubprocessTerminalIds(sessions ?? []);
}
