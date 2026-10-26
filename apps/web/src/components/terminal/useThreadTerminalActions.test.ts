import {
  AuthTerminalOperateScope,
  DEFAULT_TERMINAL_ID,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { transform } from "oxc-transform-react";
import { describe, expect, it, vi } from "vite-plus/test";

import source from "./useThreadTerminalActions.ts?raw";
import type { useThreadTerminalActions } from "./useThreadTerminalActions";
import type { useThreadTerminalWorkspace } from "../../state/terminalWorkspace";

const environmentId = EnvironmentId.make("environment-1");
const threadRef = { environmentId, threadId: ThreadId.make("draft-1") };
type Workspace = Pick<ReturnType<typeof useThreadTerminalWorkspace>, "ref" | "data" | "project">;

async function makeHarness(initialWorkspace: Workspace) {
  // Unit tests use SSR transforms, which do not run the client React Compiler.
  const compiled = await transform("useThreadTerminalActions.ts", source, {
    jsx: { runtime: "automatic", development: false, refresh: false },
    reactCompiler: { reportDiagnostics: true },
  });
  expect(compiled.errors).toEqual([]);
  let workspace = initialWorkspace;
  let cache: unknown[] | undefined;
  const command = vi.fn();
  const dependencies = {
    _c: (size: number) =>
      (cache ??= Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"))),
    AuthTerminalOperateScope,
    DEFAULT_TERMINAL_ID,
    projectScriptRuntimeEnv,
    useStableCallback: <T>(callback: T) => callback,
    randomUUID: () => "terminal-new",
    readEnvironmentScope: () => true,
    terminalEnvironment: {},
    useKnownTerminalSessions: () => null,
    useThreadTerminalWorkspace: () => workspace,
    useAtomCommand: () => command,
  };
  const code = compiled.code.replace(/^import .*;\n/gm, "").replace("export function", "function");
  const useActions = new Function(
    ...Object.keys(dependencies),
    `${code}\nreturn useThreadTerminalActions;`,
  )(...Object.values(dependencies)) as typeof useThreadTerminalActions;
  return { useActions, command, setWorkspace: (next: Workspace) => (workspace = next) };
}

describe("compiled useThreadTerminalActions", () => {
  it.each([null, threadRef])("waits for the workspace when the thread is %s", async (ref) => {
    const { useActions, command } = await makeHarness({ ref: null, data: null, project: null });
    const actions = useActions(ref);

    expect(actions.workspaceRef).toBeNull();
    expect(actions.canWrite()).toBe(false);
    expect(actions.launchTerminal({ place: vi.fn() })).toBeNull();
    expect(actions.writeToTerminal("terminal-1", "pwd\r")).toBeNull();
    actions.closeTerminalSession("terminal-1");
    expect(command).not.toHaveBeenCalled();
  });

  it("targets the resolved workspace and waits again when it becomes unavailable", async () => {
    const unresolved = { ref: null, data: null, project: null };
    const { useActions, command, setWorkspace } = await makeHarness(unresolved);
    expect(useActions(threadRef).canWrite()).toBe(false);

    const ref = { environmentId, workspaceId: "workspace-1" };
    setWorkspace({
      ref,
      data: {
        id: ref.workspaceId,
        projectId: ProjectId.make("project-1"),
        cwd: "/repo",
        worktreePath: null,
      },
      project: null,
    });
    const actions = useActions(threadRef);
    expect(actions.canWrite()).toBe(true);
    actions.writeToTerminal("terminal-1", "pwd\r");
    actions.closeTerminalSession("terminal-1");
    expect(command.mock.calls).toEqual([
      [
        {
          environmentId,
          input: {
            workspaceId: ref.workspaceId,
            terminalId: "terminal-1",
            generation: undefined,
            data: "pwd\r",
          },
        },
      ],
      [
        {
          environmentId,
          input: { workspaceId: ref.workspaceId, terminalId: "terminal-1", generation: undefined },
        },
      ],
    ]);

    setWorkspace(unresolved);
    const unavailable = useActions(threadRef);
    expect(unavailable.canWrite()).toBe(false);
    expect(unavailable.writeToTerminal("terminal-1", "pwd\r")).toBeNull();
    unavailable.closeTerminalSession("terminal-1");
    expect(command).toHaveBeenCalledTimes(2);
  });
});
