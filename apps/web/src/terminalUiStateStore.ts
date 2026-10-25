import {
  parseScopedTerminalWorkspaceKey,
  scopedTerminalWorkspaceKey,
} from "@t3tools/client-runtime/environment";
import { type ScopedTerminalWorkspaceRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "./lib/storage";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
} from "./types";

interface WorkspaceTerminalUiState {
  terminalOpen: boolean;
  terminalHeight: number;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
}

// Keep legacy thread layouts untouched; only checkout identities belong in this store.
const TERMINAL_UI_STATE_STORAGE_KEY = "t3code:checkout-terminal-state:v1";

interface PersistedTerminalUiStateStoreState {
  terminalUiStateByWorkspaceKey?: Record<string, WorkspaceTerminalUiState>;
  terminalStateByWorkspaceKey?: Record<string, WorkspaceTerminalUiState>;
}

export function migratePersistedTerminalUiStateStoreState(
  persistedState: unknown,
  _version: number,
): PersistedTerminalUiStateStoreState {
  if (!persistedState || typeof persistedState !== "object") {
    return { terminalUiStateByWorkspaceKey: {} };
  }

  const candidate = persistedState as PersistedTerminalUiStateStoreState;
  const persistedUiStateByWorkspaceKey =
    candidate.terminalUiStateByWorkspaceKey ?? candidate.terminalStateByWorkspaceKey ?? {};
  const terminalUiStateByWorkspaceKey = Object.fromEntries(
    Object.entries(persistedUiStateByWorkspaceKey).filter(([workspaceKey]) =>
      parseScopedTerminalWorkspaceKey(workspaceKey),
    ),
  );

  return { terminalUiStateByWorkspaceKey };
}

function createTerminalUiStateStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

function normalizeTerminalIds(terminalIds: string[]): string[] {
  const normalizedIds: string[] = [];
  const seen = new Set<string>();
  for (const id of terminalIds) {
    const trimmedId = id.trim();
    if (trimmedId.length === 0 || seen.has(trimmedId)) continue;
    seen.add(trimmedId);
    normalizedIds.push(trimmedId);
  }
  return normalizedIds;
}

function fallbackGroupId(terminalId: string): string {
  return `group-${terminalId}`;
}

function assignUniqueGroupId(baseId: string, usedGroupIds: Set<string>): string {
  let candidate = baseId;
  let index = 2;
  while (usedGroupIds.has(candidate)) {
    candidate = `${baseId}-${index}`;
    index += 1;
  }
  usedGroupIds.add(candidate);
  return candidate;
}

function findGroupIndexByTerminalId(
  terminalGroups: ThreadTerminalGroup[],
  terminalId: string,
): number {
  return terminalGroups.findIndex((group) => group.terminalIds.includes(terminalId));
}

function normalizeTerminalGroupIds(terminalIds: string[]): string[] {
  return normalizeTerminalIds(terminalIds);
}

function normalizeTerminalGroups(
  terminalGroups: ThreadTerminalGroup[],
  terminalIds: string[],
): ThreadTerminalGroup[] {
  if (terminalIds.length === 0) {
    return [];
  }

  const validTerminalIdSet = new Set(terminalIds);
  const assignedTerminalIds = new Set<string>();
  const nextGroups: ThreadTerminalGroup[] = [];
  const usedGroupIds = new Set<string>();

  for (const group of terminalGroups) {
    const groupTerminalIds = normalizeTerminalGroupIds(group.terminalIds).filter((terminalId) => {
      if (!validTerminalIdSet.has(terminalId)) return false;
      if (assignedTerminalIds.has(terminalId)) return false;
      return true;
    });
    if (groupTerminalIds.length === 0) continue;
    for (const terminalId of groupTerminalIds) {
      assignedTerminalIds.add(terminalId);
    }
    const baseGroupId =
      group.id.trim().length > 0
        ? group.id.trim()
        : fallbackGroupId(groupTerminalIds[0] ?? terminalIds[0] ?? "");
    nextGroups.push({
      id: assignUniqueGroupId(baseGroupId, usedGroupIds),
      terminalIds: groupTerminalIds,
      ...(group.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}),
    });
  }

  for (const terminalId of terminalIds) {
    if (assignedTerminalIds.has(terminalId)) continue;
    nextGroups.push({
      id: assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds),
      terminalIds: [terminalId],
    });
  }

  return nextGroups;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function terminalGroupsEqual(left: ThreadTerminalGroup[], right: ThreadTerminalGroup[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftGroup = left[index];
    const rightGroup = right[index];
    if (!leftGroup || !rightGroup) return false;
    if (leftGroup.id !== rightGroup.id) return false;
    if (
      (leftGroup.splitDirection ?? "horizontal") !== (rightGroup.splitDirection ?? "horizontal")
    ) {
      return false;
    }
    if (!arraysEqual(leftGroup.terminalIds, rightGroup.terminalIds)) return false;
  }
  return true;
}

function workspaceTerminalUiStateEqual(
  left: WorkspaceTerminalUiState,
  right: WorkspaceTerminalUiState,
): boolean {
  return (
    left.terminalOpen === right.terminalOpen &&
    left.terminalHeight === right.terminalHeight &&
    left.activeTerminalId === right.activeTerminalId &&
    left.activeTerminalGroupId === right.activeTerminalGroupId &&
    arraysEqual(left.terminalIds, right.terminalIds) &&
    terminalGroupsEqual(left.terminalGroups, right.terminalGroups)
  );
}

const DEFAULT_THREAD_TERMINAL_UI_STATE: WorkspaceTerminalUiState = Object.freeze({
  terminalOpen: false,
  terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
  terminalIds: [],
  activeTerminalId: "",
  terminalGroups: [],
  activeTerminalGroupId: "",
});

function createDefaultWorkspaceTerminalUiState(): WorkspaceTerminalUiState {
  return {
    ...DEFAULT_THREAD_TERMINAL_UI_STATE,
    terminalIds: [...DEFAULT_THREAD_TERMINAL_UI_STATE.terminalIds],
    terminalGroups: copyTerminalGroups(DEFAULT_THREAD_TERMINAL_UI_STATE.terminalGroups),
  };
}

function getDefaultWorkspaceTerminalUiState(): WorkspaceTerminalUiState {
  return DEFAULT_THREAD_TERMINAL_UI_STATE;
}

function normalizeWorkspaceTerminalUiState(
  state: WorkspaceTerminalUiState,
): WorkspaceTerminalUiState {
  const nextTerminalIds = normalizeTerminalIds(state.terminalIds);
  const activeTerminalId = nextTerminalIds.includes(state.activeTerminalId)
    ? state.activeTerminalId
    : (nextTerminalIds[0] ?? "");
  const terminalGroups = normalizeTerminalGroups(state.terminalGroups, nextTerminalIds);
  const activeGroupIdFromState = terminalGroups.some(
    (group) => group.id === state.activeTerminalGroupId,
  )
    ? state.activeTerminalGroupId
    : null;
  const activeGroupIdFromTerminal =
    terminalGroups.find((group) => group.terminalIds.includes(activeTerminalId))?.id ?? null;

  const normalized: WorkspaceTerminalUiState = {
    terminalOpen: state.terminalOpen,
    terminalHeight:
      Number.isFinite(state.terminalHeight) && state.terminalHeight > 0
        ? state.terminalHeight
        : DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds: nextTerminalIds,
    activeTerminalId,
    terminalGroups,
    activeTerminalGroupId:
      activeGroupIdFromState ?? activeGroupIdFromTerminal ?? terminalGroups[0]?.id ?? "",
  };
  return workspaceTerminalUiStateEqual(state, normalized) ? state : normalized;
}

function isDefaultWorkspaceTerminalUiState(state: WorkspaceTerminalUiState): boolean {
  const normalized = normalizeWorkspaceTerminalUiState(state);
  return workspaceTerminalUiStateEqual(normalized, DEFAULT_THREAD_TERMINAL_UI_STATE);
}

function isValidTerminalId(terminalId: string): boolean {
  return terminalId.trim().length > 0;
}

function terminalWorkspaceKey(workspaceRef: ScopedTerminalWorkspaceRef): string {
  return scopedTerminalWorkspaceKey(workspaceRef);
}

function copyTerminalGroups(groups: ThreadTerminalGroup[]): ThreadTerminalGroup[] {
  return groups.map((group) => ({
    id: group.id,
    terminalIds: [...group.terminalIds],
    ...(group.splitDirection === "vertical" ? { splitDirection: "vertical" as const } : {}),
  }));
}

function upsertTerminalIntoGroups(
  state: WorkspaceTerminalUiState,
  terminalId: string,
  mode: "split" | "new",
  splitDirection: "horizontal" | "vertical" = "horizontal",
): WorkspaceTerminalUiState {
  const normalized = normalizeWorkspaceTerminalUiState(state);
  const effectiveMode: "split" | "new" = normalized.terminalIds.length === 0 ? "new" : mode;
  if (!isValidTerminalId(terminalId)) {
    return normalized;
  }

  const isNewTerminal = !normalized.terminalIds.includes(terminalId);
  const terminalIds = isNewTerminal
    ? [...normalized.terminalIds, terminalId]
    : normalized.terminalIds;
  const terminalGroups = copyTerminalGroups(normalized.terminalGroups);

  const existingGroupIndex = findGroupIndexByTerminalId(terminalGroups, terminalId);
  if (existingGroupIndex >= 0) {
    terminalGroups[existingGroupIndex]!.terminalIds = terminalGroups[
      existingGroupIndex
    ]!.terminalIds.filter((id) => id !== terminalId);
    if (terminalGroups[existingGroupIndex]!.terminalIds.length === 0) {
      terminalGroups.splice(existingGroupIndex, 1);
    }
  }

  if (effectiveMode === "new") {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds);
    terminalGroups.push({ id: nextGroupId, terminalIds: [terminalId] });
    return normalizeWorkspaceTerminalUiState({
      ...normalized,
      terminalOpen: true,
      terminalIds,
      activeTerminalId: terminalId,
      terminalGroups,
      activeTerminalGroupId: nextGroupId,
    });
  }

  let activeGroupIndex = terminalGroups.findIndex(
    (group) => group.id === normalized.activeTerminalGroupId,
  );
  if (activeGroupIndex < 0) {
    activeGroupIndex = findGroupIndexByTerminalId(terminalGroups, normalized.activeTerminalId);
  }
  if (activeGroupIndex < 0) {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(
      fallbackGroupId(normalized.activeTerminalId),
      usedGroupIds,
    );
    terminalGroups.push({ id: nextGroupId, terminalIds: [normalized.activeTerminalId] });
    activeGroupIndex = terminalGroups.length - 1;
  }

  const destinationGroup = terminalGroups[activeGroupIndex];
  if (!destinationGroup) {
    return normalized;
  }
  const destinationTerminalIdSet = new Set(destinationGroup.terminalIds);

  if (
    isNewTerminal &&
    !destinationTerminalIdSet.has(terminalId) &&
    destinationGroup.terminalIds.length >= MAX_TERMINALS_PER_GROUP
  ) {
    return normalized;
  }

  if (!destinationTerminalIdSet.has(terminalId)) {
    const anchorIndex = destinationGroup.terminalIds.indexOf(normalized.activeTerminalId);
    if (anchorIndex >= 0) {
      destinationGroup.terminalIds.splice(anchorIndex + 1, 0, terminalId);
    } else {
      destinationGroup.terminalIds.push(terminalId);
    }
  }
  if (splitDirection === "vertical") {
    destinationGroup.splitDirection = "vertical";
  } else {
    delete destinationGroup.splitDirection;
  }

  return normalizeWorkspaceTerminalUiState({
    ...normalized,
    terminalOpen: true,
    terminalIds,
    activeTerminalId: terminalId,
    terminalGroups,
    activeTerminalGroupId: destinationGroup.id,
  });
}

function setWorkspaceTerminalOpen(
  state: WorkspaceTerminalUiState,
  open: boolean,
): WorkspaceTerminalUiState {
  const normalized = normalizeWorkspaceTerminalUiState(state);
  if (open && normalized.terminalIds.length === 0) {
    return upsertTerminalIntoGroups(normalized, DEFAULT_THREAD_TERMINAL_ID, "new");
  }
  if (normalized.terminalOpen === open) return normalized;
  return { ...normalized, terminalOpen: open };
}

function setWorkspaceTerminalHeight(
  state: WorkspaceTerminalUiState,
  height: number,
): WorkspaceTerminalUiState {
  const normalized = normalizeWorkspaceTerminalUiState(state);
  if (!Number.isFinite(height) || height <= 0 || normalized.terminalHeight === height) {
    return normalized;
  }
  return { ...normalized, terminalHeight: height };
}

function splitWorkspaceTerminal(
  state: WorkspaceTerminalUiState,
  terminalId: string,
  direction: "horizontal" | "vertical" = "horizontal",
): WorkspaceTerminalUiState {
  return upsertTerminalIntoGroups(state, terminalId, "split", direction);
}

function newWorkspaceTerminal(
  state: WorkspaceTerminalUiState,
  terminalId: string,
): WorkspaceTerminalUiState {
  return upsertTerminalIntoGroups(state, terminalId, "new");
}

function setWorkspaceActiveTerminal(
  state: WorkspaceTerminalUiState,
  terminalId: string,
): WorkspaceTerminalUiState {
  const normalized = normalizeWorkspaceTerminalUiState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }
  const activeTerminalGroupId =
    normalized.terminalGroups.find((group) => group.terminalIds.includes(terminalId))?.id ??
    normalized.activeTerminalGroupId;
  if (
    normalized.activeTerminalId === terminalId &&
    normalized.activeTerminalGroupId === activeTerminalGroupId
  ) {
    return normalized;
  }
  return {
    ...normalized,
    activeTerminalId: terminalId,
    activeTerminalGroupId,
  };
}

function closeWorkspaceTerminal(
  state: WorkspaceTerminalUiState,
  terminalId: string,
): WorkspaceTerminalUiState {
  const normalized = normalizeWorkspaceTerminalUiState(state);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalized;
  }

  const remainingTerminalIds = normalized.terminalIds.filter((id) => id !== terminalId);
  if (remainingTerminalIds.length === 0) {
    return createDefaultWorkspaceTerminalUiState();
  }

  const closedTerminalIndex = normalized.terminalIds.indexOf(terminalId);
  const nextActiveTerminalId =
    normalized.activeTerminalId === terminalId
      ? (remainingTerminalIds[Math.min(closedTerminalIndex, remainingTerminalIds.length - 1)] ??
        remainingTerminalIds[0] ??
        "")
      : normalized.activeTerminalId;

  const terminalGroups: ThreadTerminalGroup[] = [];
  for (const group of normalized.terminalGroups) {
    const terminalIds = group.terminalIds.filter((id) => id !== terminalId);
    if (terminalIds.length > 0) {
      terminalGroups.push({ ...group, terminalIds });
    }
  }

  const nextActiveTerminalGroupId =
    terminalGroups.find((group) => group.terminalIds.includes(nextActiveTerminalId))?.id ??
    terminalGroups[0]?.id ??
    fallbackGroupId(nextActiveTerminalId);

  return normalizeWorkspaceTerminalUiState({
    terminalOpen: normalized.terminalOpen,
    terminalHeight: normalized.terminalHeight,
    terminalIds: remainingTerminalIds,
    activeTerminalId: nextActiveTerminalId,
    terminalGroups,
    activeTerminalGroupId: nextActiveTerminalGroupId,
  });
}

function reconcileWorkspaceTerminalSessionIds(
  state: WorkspaceTerminalUiState,
  nextIds: string[],
): WorkspaceTerminalUiState {
  const normalized = normalizeWorkspaceTerminalUiState(state);
  if (arraysEqual(normalized.terminalIds, nextIds)) {
    return normalized;
  }

  const nextActiveTerminalId = nextIds.includes(normalized.activeTerminalId)
    ? normalized.activeTerminalId
    : (nextIds[0] ?? "");

  const terminalGroups = normalizeTerminalGroups(normalized.terminalGroups, nextIds);
  const activeGroupIdFromTerminal =
    terminalGroups.find((group) => group.terminalIds.includes(nextActiveTerminalId))?.id ?? null;

  return normalizeWorkspaceTerminalUiState({
    ...normalized,
    terminalIds: nextIds,
    activeTerminalId: nextActiveTerminalId,
    terminalGroups,
    activeTerminalGroupId: activeGroupIdFromTerminal ?? terminalGroups[0]?.id ?? "",
  });
}

export function selectWorkspaceTerminalUiState(
  terminalUiStateByWorkspaceKey: Record<string, WorkspaceTerminalUiState>,
  workspaceRef: ScopedTerminalWorkspaceRef | null | undefined,
): WorkspaceTerminalUiState {
  if (!workspaceRef || workspaceRef.workspaceId.length === 0) {
    return getDefaultWorkspaceTerminalUiState();
  }
  return (
    terminalUiStateByWorkspaceKey[terminalWorkspaceKey(workspaceRef)] ??
    getDefaultWorkspaceTerminalUiState()
  );
}

function updateTerminalUiStateByWorkspaceKey(
  terminalUiStateByWorkspaceKey: Record<string, WorkspaceTerminalUiState>,
  workspaceRef: ScopedTerminalWorkspaceRef,
  updater: (state: WorkspaceTerminalUiState) => WorkspaceTerminalUiState,
): Record<string, WorkspaceTerminalUiState> {
  if (workspaceRef.workspaceId.length === 0) {
    return terminalUiStateByWorkspaceKey;
  }

  const workspaceKey = terminalWorkspaceKey(workspaceRef);
  const current = selectWorkspaceTerminalUiState(terminalUiStateByWorkspaceKey, workspaceRef);
  const next = updater(current);
  if (next === current) {
    return terminalUiStateByWorkspaceKey;
  }

  if (isDefaultWorkspaceTerminalUiState(next)) {
    if (terminalUiStateByWorkspaceKey[workspaceKey] === undefined) {
      return terminalUiStateByWorkspaceKey;
    }
    const { [workspaceKey]: _removed, ...rest } = terminalUiStateByWorkspaceKey;
    return rest;
  }

  return {
    ...terminalUiStateByWorkspaceKey,
    [workspaceKey]: next,
  };
}

function updateSuppressedTerminalId(
  suppressedTerminalIdsByWorkspaceKey: Record<string, string[]>,
  workspaceRef: ScopedTerminalWorkspaceRef,
  terminalId: string,
  suppressed: boolean,
): Record<string, string[]> {
  const normalizedTerminalId = terminalId.trim();
  if (normalizedTerminalId.length === 0) {
    return suppressedTerminalIdsByWorkspaceKey;
  }
  const workspaceKey = terminalWorkspaceKey(workspaceRef);
  const currentIds = suppressedTerminalIdsByWorkspaceKey[workspaceKey] ?? [];
  const currentlySuppressed = currentIds.includes(normalizedTerminalId);
  if (currentlySuppressed === suppressed) {
    return suppressedTerminalIdsByWorkspaceKey;
  }
  if (suppressed) {
    return {
      ...suppressedTerminalIdsByWorkspaceKey,
      [workspaceKey]: [...currentIds, normalizedTerminalId],
    };
  }

  const remainingIds = currentIds.filter((id) => id !== normalizedTerminalId);
  if (remainingIds.length > 0) {
    return {
      ...suppressedTerminalIdsByWorkspaceKey,
      [workspaceKey]: remainingIds,
    };
  }
  return removeRecordEntry(suppressedTerminalIdsByWorkspaceKey, workspaceKey);
}

function removeRecordEntry<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (record[key] === undefined) {
    return record;
  }
  const { [key]: _removed, ...remaining } = record;
  return remaining;
}

interface TerminalUiStateStoreState {
  terminalUiStateByWorkspaceKey: Record<string, WorkspaceTerminalUiState>;
  /** Closed ids hidden from stale server metadata until that id is explicitly opened again. */
  suppressedTerminalIdsByWorkspaceKey: Record<string, string[]>;
  setTerminalOpen: (workspaceRef: ScopedTerminalWorkspaceRef, open: boolean) => void;
  setTerminalHeight: (workspaceRef: ScopedTerminalWorkspaceRef, height: number) => void;
  splitTerminal: (workspaceRef: ScopedTerminalWorkspaceRef, terminalId: string) => void;
  splitTerminalVertical: (workspaceRef: ScopedTerminalWorkspaceRef, terminalId: string) => void;
  newTerminal: (workspaceRef: ScopedTerminalWorkspaceRef, terminalId: string) => void;
  ensureTerminal: (
    workspaceRef: ScopedTerminalWorkspaceRef,
    terminalId: string,
    options?: { open?: boolean; active?: boolean },
  ) => void;
  setActiveTerminal: (workspaceRef: ScopedTerminalWorkspaceRef, terminalId: string) => void;
  closeTerminal: (workspaceRef: ScopedTerminalWorkspaceRef, terminalId: string) => void;
  reconcileTerminalIds: (workspaceRef: ScopedTerminalWorkspaceRef, nextIds: string[]) => void;
  clearTerminalUiState: (workspaceRef: ScopedTerminalWorkspaceRef) => void;
  removeTerminalUiState: (workspaceRef: ScopedTerminalWorkspaceRef) => void;
  removeOrphanedTerminalUiStates: (activeWorkspaceKeys: Set<string>) => void;
}

export const useTerminalUiStateStore = create<TerminalUiStateStoreState>()(
  persist(
    (set, get) => {
      const updateTerminal = (
        workspaceRef: ScopedTerminalWorkspaceRef,
        updater: (
          state: WorkspaceTerminalUiState,
          suppressedTerminalIds: readonly string[],
        ) => WorkspaceTerminalUiState,
        suppression?: { terminalId: string; suppressed: boolean },
      ) => {
        set((state) => {
          const workspaceKey = terminalWorkspaceKey(workspaceRef);
          const suppressedTerminalIds =
            state.suppressedTerminalIdsByWorkspaceKey[workspaceKey] ?? [];
          const nextTerminalUiStateByWorkspaceKey = updateTerminalUiStateByWorkspaceKey(
            state.terminalUiStateByWorkspaceKey,
            workspaceRef,
            (terminalState) => updater(terminalState, suppressedTerminalIds),
          );
          const nextSuppressedTerminalIdsByWorkspaceKey = suppression
            ? updateSuppressedTerminalId(
                state.suppressedTerminalIdsByWorkspaceKey,
                workspaceRef,
                suppression.terminalId,
                suppression.suppressed,
              )
            : state.suppressedTerminalIdsByWorkspaceKey;
          if (
            nextTerminalUiStateByWorkspaceKey === state.terminalUiStateByWorkspaceKey &&
            nextSuppressedTerminalIdsByWorkspaceKey === state.suppressedTerminalIdsByWorkspaceKey
          ) {
            return state;
          }
          return {
            terminalUiStateByWorkspaceKey: nextTerminalUiStateByWorkspaceKey,
            suppressedTerminalIdsByWorkspaceKey: nextSuppressedTerminalIdsByWorkspaceKey,
          };
        });
      };

      return {
        terminalUiStateByWorkspaceKey: {},
        suppressedTerminalIdsByWorkspaceKey: {},
        setTerminalOpen: (workspaceRef, open) => {
          const terminalState = selectWorkspaceTerminalUiState(
            get().terminalUiStateByWorkspaceKey,
            workspaceRef,
          );
          updateTerminal(
            workspaceRef,
            (state) => setWorkspaceTerminalOpen(state, open),
            open && terminalState.terminalIds.length === 0
              ? { terminalId: DEFAULT_THREAD_TERMINAL_ID, suppressed: false }
              : undefined,
          );
        },
        setTerminalHeight: (workspaceRef, height) =>
          updateTerminal(workspaceRef, (state) => setWorkspaceTerminalHeight(state, height)),
        splitTerminal: (workspaceRef, terminalId) =>
          updateTerminal(workspaceRef, (state) => splitWorkspaceTerminal(state, terminalId), {
            terminalId,
            suppressed: false,
          }),
        splitTerminalVertical: (workspaceRef, terminalId) =>
          updateTerminal(
            workspaceRef,
            (state) => splitWorkspaceTerminal(state, terminalId, "vertical"),
            {
              terminalId,
              suppressed: false,
            },
          ),
        newTerminal: (workspaceRef, terminalId) =>
          updateTerminal(workspaceRef, (state) => newWorkspaceTerminal(state, terminalId), {
            terminalId,
            suppressed: false,
          }),
        ensureTerminal: (workspaceRef, terminalId, options) =>
          updateTerminal(
            workspaceRef,
            (state) => {
              let nextState = state;
              if (!state.terminalIds.includes(terminalId)) {
                nextState = newWorkspaceTerminal(nextState, terminalId);
              }
              if (options?.active === false) {
                nextState = {
                  ...nextState,
                  activeTerminalId: state.activeTerminalId,
                  activeTerminalGroupId: state.activeTerminalGroupId,
                };
              }
              if (options?.active ?? true) {
                nextState = setWorkspaceActiveTerminal(nextState, terminalId);
              }
              if (options?.open) {
                nextState = setWorkspaceTerminalOpen(nextState, true);
              }
              return normalizeWorkspaceTerminalUiState(nextState);
            },
            { terminalId, suppressed: false },
          ),
        setActiveTerminal: (workspaceRef, terminalId) =>
          updateTerminal(workspaceRef, (state) => setWorkspaceActiveTerminal(state, terminalId)),
        closeTerminal: (workspaceRef, terminalId) =>
          updateTerminal(workspaceRef, (state) => closeWorkspaceTerminal(state, terminalId), {
            terminalId,
            suppressed: true,
          }),
        reconcileTerminalIds: (workspaceRef, nextIds) =>
          updateTerminal(workspaceRef, (state, suppressedTerminalIds) => {
            if (suppressedTerminalIds.length === 0) {
              return reconcileWorkspaceTerminalSessionIds(state, nextIds);
            }
            const suppressedIds = new Set(suppressedTerminalIds);
            return reconcileWorkspaceTerminalSessionIds(
              state,
              nextIds.filter((terminalId) => !suppressedIds.has(terminalId)),
            );
          }),
        clearTerminalUiState: (workspaceRef) =>
          set((state) => {
            const workspaceKey = terminalWorkspaceKey(workspaceRef);
            const nextTerminalUiStateByWorkspaceKey = updateTerminalUiStateByWorkspaceKey(
              state.terminalUiStateByWorkspaceKey,
              workspaceRef,
              () => createDefaultWorkspaceTerminalUiState(),
            );
            const hadSuppressedTerminalIds =
              state.suppressedTerminalIdsByWorkspaceKey[workspaceKey] !== undefined;
            if (
              nextTerminalUiStateByWorkspaceKey === state.terminalUiStateByWorkspaceKey &&
              !hadSuppressedTerminalIds
            ) {
              return state;
            }
            return {
              terminalUiStateByWorkspaceKey: nextTerminalUiStateByWorkspaceKey,
              suppressedTerminalIdsByWorkspaceKey: removeRecordEntry(
                state.suppressedTerminalIdsByWorkspaceKey,
                workspaceKey,
              ),
            };
          }),
        removeTerminalUiState: (workspaceRef) =>
          set((state) => {
            const workspaceKey = terminalWorkspaceKey(workspaceRef);
            const hadTerminalUiState =
              state.terminalUiStateByWorkspaceKey[workspaceKey] !== undefined;
            const hadSuppressedTerminalIds =
              state.suppressedTerminalIdsByWorkspaceKey[workspaceKey] !== undefined;
            if (!hadTerminalUiState && !hadSuppressedTerminalIds) {
              return state;
            }
            return {
              terminalUiStateByWorkspaceKey: removeRecordEntry(
                state.terminalUiStateByWorkspaceKey,
                workspaceKey,
              ),
              suppressedTerminalIdsByWorkspaceKey: removeRecordEntry(
                state.suppressedTerminalIdsByWorkspaceKey,
                workspaceKey,
              ),
            };
          }),
        removeOrphanedTerminalUiStates: (activeWorkspaceKeys) =>
          set((state) => {
            const orphanedIds = new Set(
              [
                ...Object.keys(state.terminalUiStateByWorkspaceKey),
                ...Object.keys(state.suppressedTerminalIdsByWorkspaceKey),
              ].filter((key) => !activeWorkspaceKeys.has(key)),
            );
            if (orphanedIds.size === 0) {
              return state;
            }
            const nextTerminalUiStateByWorkspaceKey = { ...state.terminalUiStateByWorkspaceKey };
            const nextSuppressedTerminalIdsByWorkspaceKey = {
              ...state.suppressedTerminalIdsByWorkspaceKey,
            };
            for (const id of orphanedIds) {
              delete nextTerminalUiStateByWorkspaceKey[id];
              delete nextSuppressedTerminalIdsByWorkspaceKey[id];
            }
            return {
              terminalUiStateByWorkspaceKey: nextTerminalUiStateByWorkspaceKey,
              suppressedTerminalIdsByWorkspaceKey: nextSuppressedTerminalIdsByWorkspaceKey,
            };
          }),
      };
    },
    {
      name: TERMINAL_UI_STATE_STORAGE_KEY,
      version: 4,
      storage: createJSONStorage(createTerminalUiStateStorage),
      migrate: migratePersistedTerminalUiStateStoreState,
      partialize: (state) => ({
        terminalUiStateByWorkspaceKey: state.terminalUiStateByWorkspaceKey,
      }),
    },
  ),
);
