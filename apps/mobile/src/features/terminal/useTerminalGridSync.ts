import type { TerminalSessionState } from "@t3tools/client-runtime/state/terminal";
import {
  AuthTerminalOperateScope,
  type EnvironmentId,
  type TerminalResizeInput,
} from "@t3tools/contracts";
import { useEffect } from "react";

import type { TerminalGridSize } from "./terminalUiState";
import { readEnvironmentScope } from "../../state/session";

export function useTerminalGridSync({
  environmentId,
  workspaceId,
  terminalId,
  canOperate,
  terminal,
  size,
  resize,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly workspaceId: string | null;
  readonly terminalId: string;
  readonly canOperate: boolean;
  readonly terminal: Pick<TerminalSessionState, "output" | "status" | "version" | "summary">;
  readonly size: TerminalGridSize;
  readonly resize: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: TerminalResizeInput;
  }) => void;
}): void {
  const generation =
    canOperate && terminal.version > 0 && terminal.status === "running"
      ? terminal.output.generation
      : null;

  useEffect(() => {
    if (
      generation === null ||
      environmentId === null ||
      workspaceId === null ||
      !readEnvironmentScope(environmentId, AuthTerminalOperateScope)
    )
      return;
    resize({
      environmentId,
      input: {
        workspaceId,
        terminalId,
        generation: terminal.summary?.generation,
        cols: size.cols,
        rows: size.rows,
      },
    });
  }, [
    environmentId,
    generation,
    resize,
    size.cols,
    size.rows,
    terminalId,
    workspaceId,
    terminal.summary?.generation,
  ]);
}
