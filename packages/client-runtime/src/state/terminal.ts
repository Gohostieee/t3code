import { type TerminalSummary, WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import {
  applyTerminalAttachStreamEvent,
  applyTerminalMetadataStreamEvent,
  nextTerminalAttachSeedState,
} from "./terminalSession.ts";

export function createTerminalEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const resizeScheduler = createAtomCommandScheduler();
  const terminalWorkspaceKey = ({
    environmentId,
    input,
  }: {
    readonly environmentId: string;
    readonly input: { readonly workspaceId: string; readonly terminalId?: string | undefined };
  }) => JSON.stringify([environmentId, input.workspaceId]);
  const terminalSessionKey = ({
    environmentId,
    input,
  }: {
    readonly environmentId: string;
    readonly input: { readonly workspaceId: string; readonly terminalId?: string | undefined };
  }) => JSON.stringify([environmentId, input.workspaceId, input.terminalId ?? null]);
  const lifecycleConcurrency = { mode: "serial" as const, key: terminalWorkspaceKey };
  return {
    resolve: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:resolve",
      tag: WS_METHODS.terminalResolveWorkspace,
    }),
    legacyHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:terminal:legacy-history",
      tag: WS_METHODS.terminalLegacyHistory,
    }),
    workspaces: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:terminal:workspaces",
      tag: WS_METHODS.terminalListWorkspaces,
    }),
    resolveWorkspace: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:terminal:workspace",
      tag: WS_METHODS.terminalResolveWorkspace,
    }),
    observe: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:observe",
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.terminalObserve>) =>
        Stream.suspend(() =>
          subscribe(WS_METHODS.terminalObserve, input).pipe(
            Stream.scan(nextTerminalAttachSeedState, applyTerminalAttachStreamEvent),
          ),
        ),
    }),
    attach: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:attach",
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.terminalAttach>) =>
        Stream.suspend(() =>
          subscribe(WS_METHODS.terminalAttach, input).pipe(
            Stream.scan(nextTerminalAttachSeedState, applyTerminalAttachStreamEvent),
          ),
        ),
    }),
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:events",
      tag: WS_METHODS.subscribeTerminalEvents,
    }),
    metadata: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:terminal:metadata",
      subscribe: (_input: null) =>
        subscribe(WS_METHODS.subscribeTerminalMetadata, {}).pipe(
          Stream.scan((): ReadonlyArray<TerminalSummary> => [], applyTerminalMetadataStreamEvent),
          // The scan seed is not an authoritative empty server snapshot.
          Stream.drop(1),
        ),
    }),
    runTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:task",
      tag: WS_METHODS.terminalRunTask,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:open",
      tag: WS_METHODS.terminalOpen,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    write: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:write",
      tag: WS_METHODS.terminalWrite,
    }),
    resize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:resize",
      tag: WS_METHODS.terminalResize,
      scheduler: resizeScheduler,
      concurrency: { mode: "latest", key: terminalSessionKey },
    }),
    clear: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:clear",
      tag: WS_METHODS.terminalClear,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    restart: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:restart",
      tag: WS_METHODS.terminalRestart,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:terminal:close",
      tag: WS_METHODS.terminalClose,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
  };
}

export * from "./terminalSession.ts";
