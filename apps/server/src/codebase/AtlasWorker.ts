import * as NodeWorkerThreads from "node:worker_threads";
// @effect-diagnostics nodeBuiltinImport:off
import { extractAtlas, type AtlasSyntaxCache } from "./AtlasExtractor.ts";
import type { CodebaseBinding } from "./CodebaseArtifactStore.ts";
import type { AtlasApp } from "@t3tools/contracts";

type Input = {
  type: "extract";
  binding: Pick<CodebaseBinding, "checkout" | "inventory" | "sourceFingerprint">;
  app: AtlasApp;
};
const syntaxCache: AtlasSyntaxCache = { files: new Map(), bytes: 0 };
let configuration = "";
NodeWorkerThreads.parentPort?.on("message", async (input: Input | { type: "continue" }) => {
  if (input.type !== "extract") return;
  const current = JSON.stringify([
    input.binding.checkout,
    input.app,
    input.binding.inventory
      .filter((file) =>
        /(?:^|\/)(?:package\.json|.*lock.*|tsconfig.*\.json|.*\.config\.[^/]+)$/.test(file.path),
      )
      .map((file) => [file.path, file.fingerprint]),
  ]);
  if (current !== configuration) {
    syntaxCache.files.clear();
    syntaxCache.bytes = 0;
  }
  configuration = current;
  let lastPhase = "";
  try {
    const document = await extractAtlas(
      input.binding,
      input.app,
      async (phase, path) => {
        if (phase !== lastPhase) {
          lastPhase = phase;
          const accepted = new Promise<void>((resolve) =>
            NodeWorkerThreads.parentPort?.once("message", () => resolve()),
          );
          NodeWorkerThreads.parentPort?.postMessage({ type: "progress", phase, path });
          await accepted;
        }
      },
      new AbortController().signal,
      syntaxCache,
    );
    NodeWorkerThreads.parentPort?.postMessage({ type: "result", document });
  } catch (cause) {
    NodeWorkerThreads.parentPort?.postMessage({ type: "error", message: String(cause) });
  }
});
