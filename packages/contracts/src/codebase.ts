import * as Schema from "effect/Schema";
import { CommandId, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import { ProviderOptionSelection } from "./model.ts";

export const CODEBASE_DIRECTORY = ".t3-codebase";
export const CODEBASE_LIMITS = {
  documentBytes: 512 * 1024,
  nodes: 80,
  edges: 200,
  sourceFiles: 20_000,
  sourceFileBytes: 1024 * 1024,
  promptCharacters: 90_000,
} as const;

const ShortText = TrimmedNonEmptyString.check(Schema.isMaxLength(240));
const Explanation = TrimmedNonEmptyString.check(Schema.isMaxLength(4_000));
export const CodebaseScopeId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-zA-Z0-9_-]+$/),
);
export const CodebaseRelativePath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.makeFilter(
    (path) =>
      !path.includes("\\") &&
      !path.includes(":") &&
      !path.startsWith("/") &&
      !path.includes("\0") &&
      path.split("/").every((part) => part !== ".." && part !== "." && part.length > 0),
    { message: "Expected a normalized project-relative file path" },
  ),
);
export const CodebaseSource = Schema.Struct({
  path: CodebaseRelativePath,
  startLine: Schema.Int.check(Schema.isGreaterThan(0)),
  endLine: Schema.Int.check(Schema.isGreaterThan(0)),
  symbol: Schema.optional(ShortText),
  fingerprint: Schema.optional(Schema.String),
}).check(
  Schema.makeFilter((source) => source.endLine >= source.startLine, {
    message: "Source range must end at or after its start",
  }),
);
export type CodebaseSource = typeof CodebaseSource.Type;

export const CodebaseAnalyzer = Schema.Struct({
  driverKind: ProviderDriverKind,
  model: ShortText,
  options: Schema.optional(Schema.Array(ProviderOptionSelection).check(Schema.isMaxLength(20))),
});
export type CodebaseAnalyzer = typeof CodebaseAnalyzer.Type;
export const CodebaseAnalyzers = Schema.Struct({
  default: Schema.optional(CodebaseAnalyzer),
  overview: Schema.optional(CodebaseAnalyzer),
  detail: Schema.optional(CodebaseAnalyzer),
});
export type CodebaseAnalyzers = typeof CodebaseAnalyzers.Type;
export const CodebaseManifest = Schema.Struct({
  version: Schema.Literal(1),
  projectPath: Schema.Union([Schema.Literal("."), CodebaseRelativePath]),
  rootScopeId: Schema.Literal("overview"),
  analyzers: CodebaseAnalyzers,
});
export type CodebaseManifest = typeof CodebaseManifest.Type;

export const CodebaseNode = Schema.Struct({
  id: CodebaseScopeId,
  kind: ShortText,
  name: ShortText,
  responsibility: ShortText,
  explanation: Explanation,
  technologies: Schema.Array(ShortText).check(Schema.isMaxLength(20)),
  sources: Schema.Array(CodebaseSource).check(Schema.isMaxLength(20)),
  expandable: Schema.Boolean,
  childScopeId: Schema.optional(CodebaseScopeId),
  boundaryScopeId: Schema.optional(CodebaseScopeId),
  inputs: Schema.optional(Schema.Array(ShortText).check(Schema.isMaxLength(20))),
  outputs: Schema.optional(Schema.Array(ShortText).check(Schema.isMaxLength(20))),
  sideEffects: Schema.optional(Schema.Array(ShortText).check(Schema.isMaxLength(20))),
});
export type CodebaseNode = typeof CodebaseNode.Type;
export const CodebaseEdge = Schema.Struct({
  id: CodebaseScopeId,
  from: CodebaseScopeId,
  to: CodebaseScopeId,
  kind: Schema.Literals([
    "imports",
    "renders",
    "calls",
    "requests",
    "events",
    "reads",
    "writes",
    "depends-on",
  ]),
  label: ShortText,
  explanation: Explanation,
  evidence: Schema.Literals(["source-backed", "inferred"]),
  sources: Schema.Array(CodebaseSource).check(Schema.isMaxLength(20)),
});
export type CodebaseEdge = typeof CodebaseEdge.Type;
export const CodebaseGraph = Schema.Struct({
  title: ShortText,
  summary: Explanation,
  nodes: Schema.Array(CodebaseNode).check(Schema.isMaxLength(CODEBASE_LIMITS.nodes)),
  edges: Schema.Array(CodebaseEdge).check(Schema.isMaxLength(CODEBASE_LIMITS.edges)),
  omissions: Schema.Array(ShortText).check(Schema.isMaxLength(100)),
}).check(
  Schema.makeFilter(
    (graph) => {
      const nodes = new Set(graph.nodes.map((node) => node.id));
      return (
        nodes.size === graph.nodes.length &&
        new Set(graph.edges.map((edge) => edge.id)).size === graph.edges.length &&
        graph.edges.every(
          (edge) =>
            nodes.has(edge.from) &&
            nodes.has(edge.to) &&
            (edge.evidence !== "source-backed" || edge.sources.length > 0),
        )
      );
    },
    {
      message:
        "Node and edge IDs must be unique, endpoints must exist, and source-backed edges need sources",
    },
  ),
);
export type CodebaseGraph = typeof CodebaseGraph.Type;

export const CodebaseScope = Schema.Struct({
  version: Schema.Literal(1),
  scopeId: CodebaseScopeId,
  parentScopeId: Schema.NullOr(CodebaseScopeId),
  graph: CodebaseGraph,
  sourceFingerprint: Schema.String,
  configurationFingerprint: Schema.String,
  coverage: Schema.Struct({
    inventoryFiles: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    referencedFiles: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    omittedFiles: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  provenance: Schema.Struct({ analyzer: CodebaseAnalyzer, promptVersion: Schema.Literal(1) }),
});
export type CodebaseScope = typeof CodebaseScope.Type;

export const CodebaseAnalysisStatus = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "validating",
  "saving",
  "succeeded",
  "failed",
  "cancelled",
  "input-changed",
]);
export type CodebaseAnalysisStatus = typeof CodebaseAnalysisStatus.Type;
export const CodebaseAnalysis = Schema.Struct({
  requestId: CommandId,
  checkout: Schema.String,
  scopeId: CodebaseScopeId,
  parentScopeId: Schema.NullOr(CodebaseScopeId),
  passKind: Schema.Literals(["overview", "detail"]),
  status: CodebaseAnalysisStatus,
  expectedRevision: Schema.NullOr(Schema.String),
  configurationRevision: Schema.NullOr(Schema.String),
  parentRevision: Schema.NullOr(Schema.String),
  sourceFingerprint: Schema.String,
  gitHead: Schema.String,
  gitBranch: Schema.NullOr(Schema.String),
  analyzer: CodebaseAnalyzer,
  acceptedRevision: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type CodebaseAnalysis = typeof CodebaseAnalysis.Type;
export const isCodebaseAnalysisActive = (status: CodebaseAnalysisStatus) =>
  status === "queued" ||
  status === "running" ||
  status === "waiting" ||
  status === "validating" ||
  status === "saving";

export class CodebaseError extends Schema.TaggedErrorClass<CodebaseError>()("CodebaseError", {
  code: Schema.Literals(["unavailable", "unsupported", "invalid", "conflict", "busy", "io"]),
  message: Schema.String,
}) {}
