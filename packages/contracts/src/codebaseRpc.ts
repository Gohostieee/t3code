import { ProviderInstanceId } from "./providerInstance.ts";
import * as Schema from "effect/Schema";
import { CommandId, ProjectId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";
import {
  CodebaseAnalysis,
  CodebaseAnalyzers,
  CodebaseManifest,
  CodebaseScope,
  CodebaseScopeId,
} from "./codebase.ts";

export const CodebaseCheckoutInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
  checkout: Schema.optional(Schema.String),
});
export type CodebaseCheckoutInput = typeof CodebaseCheckoutInput.Type;
export const CodebaseReadInput = Schema.Struct({
  ...CodebaseCheckoutInput.fields,
  scopeId: CodebaseScopeId,
});
export type CodebaseReadInput = typeof CodebaseReadInput.Type;
export const CodebaseMapState = Schema.Literals([
  "ready",
  "unbuilt",
  "invalid",
  "conflicted",
  "unsupported",
  "inaccessible",
]);
export const CodebaseAnalyzerBindings = Schema.Struct({
  default: Schema.optional(Schema.NullOr(ModelSelection)),
  overview: Schema.optional(Schema.NullOr(ModelSelection)),
  detail: Schema.optional(Schema.NullOr(ModelSelection)),
});
export const CodebaseSnapshot = Schema.Struct({
  checkout: Schema.String,
  branch: Schema.NullOr(Schema.String),
  head: Schema.NullOr(Schema.String),
  state: CodebaseMapState,
  freshness: Schema.Literals(["current", "stale", "unknown"]),
  revision: Schema.NullOr(Schema.String),
  configurationRevision: Schema.NullOr(Schema.String),
  manifest: Schema.NullOr(CodebaseManifest),
  scope: Schema.NullOr(CodebaseScope),
  detail: Schema.NullOr(Schema.String),
  ignored: Schema.Boolean,
  analyzerBindings: Schema.optional(CodebaseAnalyzerBindings),
  supportedProviderInstanceIds: Schema.optional(Schema.Array(ProviderInstanceId)),
  worktrees: Schema.optional(Schema.Array(Schema.String)),
});
export type CodebaseSnapshot = typeof CodebaseSnapshot.Type;
export const CodebaseRun = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  analysis: CodebaseAnalysis,
});
export type CodebaseRun = typeof CodebaseRun.Type;
export const CodebaseStartInput = Schema.Struct({
  ...CodebaseReadInput.fields,
  commandId: CommandId,
  parentScopeId: Schema.NullOr(CodebaseScopeId),
  expectedRevision: Schema.NullOr(Schema.String),
  modelSelection: ModelSelection,
});
export type CodebaseStartInput = typeof CodebaseStartInput.Type;
export const CodebaseConfigureInput = Schema.Struct({
  ...CodebaseCheckoutInput.fields,
  expectedRevision: Schema.NullOr(Schema.String),
  analyzers: CodebaseAnalyzers,
  analyzerBindings: Schema.optional(CodebaseAnalyzerBindings),
});
export type CodebaseConfigureInput = typeof CodebaseConfigureInput.Type;
export const CodebaseCancelInput = Schema.Struct({
  ...CodebaseCheckoutInput.fields,
  runThreadId: ThreadId,
});
export type CodebaseCancelInput = typeof CodebaseCancelInput.Type;
export const CodebaseProgress = Schema.Struct({
  checkout: Schema.String,
  runs: Schema.Array(CodebaseRun).check(Schema.isMaxLength(50)),
  artifactsChanged: Schema.Boolean,
  diskRevision: Schema.optional(Schema.String),
});
export type CodebaseProgress = typeof CodebaseProgress.Type;
