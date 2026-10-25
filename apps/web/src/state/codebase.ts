import { createCodebaseEnvironmentAtoms } from "@t3tools/client-runtime/state/codebase";
import { connectionAtomRuntime } from "../connection/runtime";

export const codebaseEnvironment = createCodebaseEnvironmentAtoms(connectionAtomRuntime);
