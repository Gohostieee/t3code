import type { EnvironmentId } from "@t3tools/contracts";

export interface TerminalGridSize {
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalUiStateTarget {
  readonly environmentId: EnvironmentId;
  readonly workspaceId: string;
  readonly terminalId: string;
}

const selectedTerminalCache = new Map<string, string>();
type CheckoutTarget = Pick<TerminalUiStateTarget, "environmentId" | "workspaceId">;

export function getSelectedTerminal(target: CheckoutTarget): string | null {
  return (
    selectedTerminalCache.get(JSON.stringify([target.environmentId, target.workspaceId])) ?? null
  );
}

export function cacheSelectedTerminal(target: TerminalUiStateTarget): void {
  selectedTerminalCache.set(
    JSON.stringify([target.environmentId, target.workspaceId]),
    target.terminalId,
  );
}

const terminalGridSizeCache = new Map<string, TerminalGridSize>();

function terminalUiStateKey(target: TerminalUiStateTarget): string {
  return `${target.environmentId}:${target.workspaceId}:${target.terminalId}`;
}

export function getCachedTerminalGridSize(target: TerminalUiStateTarget): TerminalGridSize | null {
  return terminalGridSizeCache.get(terminalUiStateKey(target)) ?? null;
}

export function cacheTerminalGridSize(
  target: TerminalUiStateTarget,
  size: TerminalGridSize,
): TerminalGridSize {
  const normalized = {
    cols: Math.max(1, Math.floor(size.cols)),
    rows: Math.max(1, Math.floor(size.rows)),
  };
  terminalGridSizeCache.set(terminalUiStateKey(target), normalized);
  return normalized;
}

export function resetTerminalUiStateCaches() {
  terminalGridSizeCache.clear();
  selectedTerminalCache.clear();
}
