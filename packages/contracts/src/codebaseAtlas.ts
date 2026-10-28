import * as Schema from "effect/Schema";
import { CommandId, ProjectId, ThreadId } from "./baseSchemas.ts";
import { CodebaseRelativePath } from "./codebase.ts";

const Text = Schema.String.check(Schema.isMaxLength(2048));
const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,100}$/));
const Values = Schema.Record(Schema.String, Text).check(Schema.isMaxProperties(50));
export const AtlasSource = Schema.Struct({
  path: CodebaseRelativePath,
  startLine: Schema.Int,
  endLine: Schema.Int,
  fingerprint: Text,
});
export const AtlasParameter = Schema.Struct({
  name: Text,
  kind: Schema.Literals(["single", "catch-all", "optional-catch-all"]),
});
export const AtlasNode = Schema.Struct({
  id: Id,
  kind: Schema.Literals([
    "route",
    "endpoint",
    "module",
    "component",
    "symbol",
    "layout",
    "boundary",
  ]),
  label: Text,
  source: AtlasSource,
  pattern: Schema.NullOr(Text),
  parameters: Schema.Array(AtlasParameter),
  layouts: Schema.Array(Id),
  boundaries: Schema.Array(Id),
  methods: Schema.Array(Text),
  roles: Schema.Array(Text),
});
export type AtlasNode = typeof AtlasNode.Type;
export const AtlasEdge = Schema.Struct({
  id: Id,
  from: Id,
  to: Id,
  kind: Schema.Literals([
    "declares",
    "imports",
    "re-exports",
    "type-dependency",
    "jsx-uses",
    "route-entry",
    "layout-wraps",
    "boundary-applies",
    "slot",
    "intercepts",
  ]),
  evidence: Schema.Literals(["syntax", "symbol-resolution", "framework-rule"]),
  rule: Text,
  source: AtlasSource,
});
export type AtlasEdge = typeof AtlasEdge.Type;
export const AtlasDiagnostic = Schema.Struct({ path: Text, code: Text, message: Text });
export const AtlasFile = Schema.Struct({
  path: Text,
  fingerprint: Text,
  status: Schema.Literals(["parsed", "metadata", "unsupported", "excluded", "parse-error"]),
  reason: Schema.NullOr(Text),
});
export const AtlasApp = Schema.Struct({
  root: Text,
  name: Text,
  framework: Schema.Literals(["next-app", "tanstack", "generic"]),
  version: Text,
  supported: Schema.Boolean,
});
export type AtlasApp = typeof AtlasApp.Type;
export const AtlasCoverage = Schema.Struct({
  totalFiles: Schema.Int,
  parsedFiles: Schema.Int,
  unresolved: Schema.Int,
  routes: Schema.Int,
  endpoints: Schema.Int,
  partial: Schema.Boolean,
});
export const AtlasDocument = Schema.Struct({
  version: Schema.Literal(2),
  extractor: Text,
  app: AtlasApp,
  sourceFingerprint: Text,
  nodes: Schema.Array(AtlasNode),
  edges: Schema.Array(AtlasEdge),
  files: Schema.Array(AtlasFile),
  diagnostics: Schema.Array(AtlasDiagnostic),
  coverage: AtlasCoverage,
});
export type AtlasDocument = typeof AtlasDocument.Type;
export const AtlasFeature = Schema.Struct({
  id: Id,
  name: Text,
  description: Text,
  members: Schema.Array(Id).check(Schema.isMaxLength(500)),
});
export type AtlasFeature = typeof AtlasFeature.Type;
export const AtlasScenario = Schema.Struct({
  id: Id,
  routeId: Id,
  name: Text,
  parameters: Values,
  query: Values,
  relativePath: Schema.optional(Text),
  viewport: Schema.Literals(["desktop", "mobile"]),
  theme: Schema.Literals(["light", "dark"]),
  readiness: Schema.Struct({ kind: Schema.Literals(["text", "locator"]), value: Text }),
  expectedPath: Schema.optional(Text),
  expectedStatus: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  ),
  sessionId: Schema.optional(Id),
});
export type AtlasScenario = typeof AtlasScenario.Type;
export const AtlasDocumentation = Schema.Struct({
  version: Schema.Literal(1),
  features: Schema.Array(AtlasFeature).check(Schema.isMaxLength(500)),
  scenarios: Schema.Array(AtlasScenario).check(Schema.isMaxLength(100)),
});
export type AtlasDocumentation = typeof AtlasDocumentation.Type;
export const AtlasTarget = Schema.Struct({
  origin: Text,
  prefix: Text,
  revision: Text,
  provenance: Schema.Literal("user-confirmed; running source unverified"),
});
export type AtlasTarget = typeof AtlasTarget.Type;
export const AtlasJob = Schema.Struct({
  attachedTo: Schema.optional(Id),
  id: Id,
  kind: Schema.Literals(["index", "capture", "browser-setup"]),
  status: Schema.Literals([
    "queued",
    "inventorying",
    "parsing",
    "resolving",
    "validating",
    "publishing",
    "capturing",
    "completed",
    "partial",
    "cancelled",
    "interrupted",
    "input-changed",
    "failed",
    "unavailable",
  ]),
  label: Text,
  detail: Schema.NullOr(Text),
  revision: Schema.NullOr(Text),
  updatedAt: Text,
});
export type AtlasJob = typeof AtlasJob.Type;
export const AtlasCapture = Schema.Struct({
  id: Id,
  scenarioId: Id,
  revision: Text,
  scenarioRevision: Text,
  targetRevision: Text,
  createdAt: Text,
  outcome: Schema.Literals([
    "ready",
    "expected-redirect",
    "expected-error",
    "unexpected-redirect",
    "http-failure",
    "readiness-failure",
    "unreachable",
    "unavailable",
    "input-changed",
  ]),
  detail: Text,
  available: Schema.Boolean,
  outdated: Schema.Boolean,
  imageUrl: Schema.optional(Text),
  thumbnailUrl: Schema.optional(Text),
});
export type AtlasCapture = typeof AtlasCapture.Type;
export const AtlasAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("read") }),
  Schema.Struct({
    type: Schema.Literal("index"),
    commandId: CommandId,
    expectedRevision: Schema.NullOr(Text),
  }),
  Schema.Struct({ type: Schema.Literal("cancel"), jobId: Id }),
  Schema.Struct({
    type: Schema.Literal("documentation"),
    expectedRevision: Schema.NullOr(Text),
    documentation: AtlasDocumentation,
  }),
  Schema.Struct({ type: Schema.Literal("attach"), origin: Schema.NullOr(Text), prefix: Text }),
  Schema.Struct({
    type: Schema.Literal("session"),
    id: Id,
    name: Text,
    storageState: Schema.NullOr(Schema.String.check(Schema.isMaxLength(262144))),
  }),
  Schema.Struct({ type: Schema.Literal("private-value"), name: Id, value: Schema.NullOr(Text) }),
  Schema.Struct({
    type: Schema.Literal("capture"),
    commandId: CommandId,
    scenarioIds: Schema.Array(Id).check(Schema.isMinLength(1)).check(Schema.isMaxLength(20)),
  }),
  Schema.Struct({ type: Schema.Literal("delete-capture"), captureId: Id }),
  Schema.Struct({ type: Schema.Literal("browser-setup"), commandId: CommandId }),
]);
export const CodebaseAtlasInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
  checkout: Schema.optional(Schema.String),
  appRoot: Schema.optional(Text),
  action: AtlasAction,
  view: Schema.optional(Schema.Literals(["all", "routes", "modules", "files", "diagnostics"])),
  query: Schema.optional(Text),
  ungrouped: Schema.optional(Schema.Boolean),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  nodeId: Schema.optional(Id),
  verifyFreshness: Schema.optional(Schema.Boolean),
});
export type CodebaseAtlasInput = typeof CodebaseAtlasInput.Type;
export const CodebaseAtlasReadInput = Schema.Struct({
  ...CodebaseAtlasInput.fields,
  action: Schema.Struct({ type: Schema.Literal("read") }),
});
export const CodebaseAtlasSnapshot = Schema.Struct({
  checkout: Text,
  branch: Schema.NullOr(Text),
  appRoot: Text,
  apps: Schema.Array(AtlasApp),
  state: Schema.Literals(["ready", "unbuilt", "invalid", "conflicted", "unsupported"]),
  revision: Schema.NullOr(Text),
  freshness: Schema.Literals(["current", "stale", "unknown"]),
  nodes: Schema.Array(AtlasNode).check(Schema.isMaxLength(80)),
  edges: Schema.Array(AtlasEdge).check(Schema.isMaxLength(200)),
  files: Schema.Array(AtlasFile).check(Schema.isMaxLength(50)),
  diagnostics: Schema.Array(AtlasDiagnostic).check(Schema.isMaxLength(50)),
  total: Schema.Int,
  totalEdges: Schema.Int,
  viewPartial: Schema.Boolean,
  coverage: AtlasCoverage,
  documentation: AtlasDocumentation,
  documentationRevision: Schema.NullOr(Text),
  jobs: Schema.Array(AtlasJob).check(Schema.isMaxLength(50)),
  captures: Schema.Array(AtlasCapture).check(Schema.isMaxLength(100)),
  target: Schema.NullOr(AtlasTarget),
  sessions: Schema.Array(Schema.Struct({ id: Id, name: Text })),
  privateValueNames: Schema.Array(Text),
  browserAvailable: Schema.Boolean,
  detail: Schema.NullOr(Text),
});
export type CodebaseAtlasSnapshot = typeof CodebaseAtlasSnapshot.Type;
