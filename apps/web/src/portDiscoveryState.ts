import type { DiscoveredLocalServer, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { previewEnvironment } from "./state/preview";
import { useEnvironmentQuery } from "./state/query";
import { useThreadTerminalWorkspace } from "./state/terminalWorkspace";

const EMPTY_PORTS: ReadonlyArray<DiscoveredLocalServer> = Object.freeze([]);

export function useDiscoveredPorts(
  environmentId: EnvironmentId | null,
): ReadonlyArray<DiscoveredLocalServer> {
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : previewEnvironment.discoveredServers({ environmentId, input: {} }),
  );
  return query.data?.servers ?? EMPTY_PORTS;
}

export function useThreadDiscoveredPorts(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
}): ReadonlyArray<DiscoveredLocalServer> {
  const ports = useDiscoveredPorts(input.environmentId);
  const workspace = useThreadTerminalWorkspace(
    input.environmentId && input.threadId
      ? { environmentId: input.environmentId, threadId: input.threadId }
      : null,
  );
  return useMemo(
    () =>
      workspace.data
        ? ports.filter((port) => port.terminal?.workspaceId === workspace.data?.id)
        : EMPTY_PORTS,
    [workspace.data, ports],
  );
}

export function useTerminalDiscoveredPorts(input: {
  readonly environmentId: EnvironmentId | null;
  readonly workspaceId: string | null;
  readonly terminalId: string | null;
}): ReadonlyArray<DiscoveredLocalServer> {
  const ports = useDiscoveredPorts(input.environmentId);
  return useMemo(
    () =>
      input.workspaceId && input.terminalId
        ? ports.filter(
            (port) =>
              port.terminal?.workspaceId === input.workspaceId &&
              port.terminal.terminalId === input.terminalId,
          )
        : EMPTY_PORTS,
    [input.terminalId, input.workspaceId, ports],
  );
}
