import {
  WS_METHODS,
  type CodebaseProgress,
  type CodebaseAnalyzers,
  type CodebaseAnalyzer,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Portable defaults select a model; an environment-local binding selects its account. */
export function resolveCodebaseAnalyzer(input: {
  analyzers: CodebaseAnalyzers;
  passKind: "overview" | "detail";
  providers: ReadonlyArray<ServerProvider>;
  chatDefault: ModelSelection | null;
  binding?: ModelSelection | null | undefined;
  override?: ModelSelection | null | undefined;
}): { selection: ModelSelection | null; reason: string | null } {
  const validate = (selection: ModelSelection | null) => {
    const provider = input.providers.find(
      (entry) =>
        entry.instanceId === selection?.instanceId &&
        entry.enabled &&
        entry.installed &&
        entry.availability !== "unavailable",
    );
    const model = provider?.models.find((entry) => entry.slug === selection?.model);
    const invalidOption = selection?.options?.find((option) => {
      const descriptor = model?.capabilities?.optionDescriptors?.find(
        (entry) => entry.id === option.id,
      );
      return (
        !descriptor ||
        (descriptor.type === "boolean"
          ? typeof option.value !== "boolean"
          : !descriptor.options.some((entry) => entry.id === option.value))
      );
    });
    return {
      selection,
      reason: !model
        ? "The selected analyzer is unavailable. Choose a replacement."
        : invalidOption
          ? `Update the unsupported model option: ${invalidOption.id}.`
          : null,
    };
  };
  if (input.override) return validate(input.override);
  const preference = input.analyzers[input.passKind] ?? input.analyzers.default;
  if (!preference) return validate(input.binding ?? input.chatDefault);
  const matching = input.providers.filter(
    (provider) =>
      provider.enabled &&
      provider.driver === preference.driverKind &&
      provider.models.some((model) => model.slug === preference.model),
  );
  const instance =
    matching.find((provider) => provider.instanceId === input.binding?.instanceId) ??
    (matching.length === 1 ? matching[0] : null);
  return instance
    ? validate({
        instanceId: instance.instanceId,
        model: preference.model,
        ...(preference.options ? { options: preference.options } : {}),
      })
    : {
        selection: null,
        reason:
          matching.length > 1
            ? "Choose which configured account should run this analysis."
            : "The saved analyzer is unavailable in this environment. Choose a replacement.",
      };
}

export function portableCodebaseAnalyzer(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): CodebaseAnalyzer | null {
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  return provider
    ? {
        driverKind: provider.driver,
        model: selection.model,
        ...(selection.options ? { options: selection.options } : {}),
      }
    : null;
}

export function createCodebaseEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    read: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "codebase:read",
      tag: WS_METHODS.codebaseRead,
      staleTimeMs: 0,
    }),
    progress: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "codebase:progress",
      tag: WS_METHODS.codebaseSubscribe,
      idleTtlMs: 0,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "codebase:start",
      tag: WS_METHODS.codebaseStart,
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.projectId}:${input.checkout ?? input.threadId ?? "main"}:${input.commandId}`,
      },
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "codebase:cancel",
      tag: WS_METHODS.codebaseCancel,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "codebase:configure",
      tag: WS_METHODS.codebaseConfigure,
    }),
    source: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "codebase:source",
      tag: WS_METHODS.projectsReadFile,
      staleTimeMs: 0,
    }),
  };
}

/** Progress contains no graph data. Only reconciliations and accepted revisions invalidate maps. */
export function codebaseProgressRevision(progress: CodebaseProgress | null): string {
  if (!progress) return "";
  return `${progress.checkout}:${progress.diskRevision ?? ""}:${progress.runs.map((run) => `${run.threadId}:${run.analysis.acceptedRevision ?? ""}:${run.analysis.status === "succeeded"}`).join("|")}`;
}
