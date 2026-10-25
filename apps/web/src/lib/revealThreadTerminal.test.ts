import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { selectWorkspaceTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { revealThreadTerminal } from "./revealThreadTerminal";

const threadRef = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("settled-thread"));
const remoteRef = scopeThreadRef(EnvironmentId.make("remote"), threadRef.threadId);

const workspaceRef = { environmentId: threadRef.environmentId, workspaceId: "workspace-1" };
const remoteWorkspaceRef = { ...workspaceRef, environmentId: remoteRef.environmentId };

beforeEach(() => {
  useTerminalUiStateStore.setState({
    terminalUiStateByWorkspaceKey: {},
    suppressedTerminalIdsByWorkspaceKey: {},
  });
  useRightPanelStore.setState({ byThreadKey: {} });
});

it("reopens the existing panel and selects a running terminal in its split", () => {
  const panels = useRightPanelStore.getState();
  panels.openTerminal(threadRef, "terminal-1", workspaceRef.workspaceId);
  const surfaceId = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  ).activeSurfaceId!;
  panels.splitTerminal(threadRef, surfaceId, "setup-install");
  panels.activateTerminal(threadRef, surfaceId, "terminal-1");
  panels.close(threadRef);

  revealThreadTerminal(threadRef, "setup-install", workspaceRef);
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef),
  ).toMatchObject({
    isOpen: true,
    activeSurfaceId: surfaceId,
    surfaces: [
      {
        terminalIds: ["terminal-1", "setup-install"],
        activeTerminalId: "setup-install",
      },
    ],
  });
  expect(
    selectWorkspaceTerminalUiState(
      useTerminalUiStateStore.getState().terminalUiStateByWorkspaceKey,
      workspaceRef,
    ).terminalIds,
  ).toEqual([]);
});

it("reveals terminals in their own environment without changing another environment's drawer", () => {
  revealThreadTerminal(threadRef, "default", workspaceRef);
  revealThreadTerminal(remoteRef, "setup-install", remoteWorkspaceRef);
  const state = useTerminalUiStateStore.getState().terminalUiStateByWorkspaceKey;
  expect(selectWorkspaceTerminalUiState(state, workspaceRef).terminalIds).toEqual(["default"]);
  expect(selectWorkspaceTerminalUiState(state, remoteWorkspaceRef).terminalIds).toEqual([
    "setup-install",
  ]);
});
