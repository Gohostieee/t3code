import { expect, it } from "vite-plus/test";
import { ProviderDriverKind, type CodebaseScope } from "@t3tools/contracts";
import {
  codebaseCoverage,
  codebaseDependencies,
  codebaseModuleReferences,
  codebaseWorkspacePackage,
  codebaseIndexReport,
  indexedScope,
  isIndexedScopeCurrent,
  updateCodebaseIndex,
  type CodebaseIndex,
  type IndexedFile,
} from "./CodebaseIndex.ts";

const file = (path: string, dependsOn: string[] = []): IndexedFile => ({
  path,
  sha256: "original",
  fingerprint: "original",
  lines: 10,
  exclusion: null,
  dependsOn,
});
const scope = (scopeId: string, path: string, dependencies = [path]) => ({
  scopeId,
  parentScopeId: "overview",
  title: scopeId,
  sourceFingerprint: "old",
  configurationFingerprint: "config",
  inspectedSources: [{ path, startLine: 1, endLine: 10, fingerprint: "original" }],
  inputs: dependencies.map((path) => ({ path, fingerprint: "original" })),
});

it("resolves literal imports, re-exports, dynamic literals, and workspace exports without interpreting comments", () => {
  const dependencies = codebaseDependencies([
    {
      path: "app/main.ts",
      text: `// import './fake.ts';\nconst example = "import './fake.ts'";\nimport { a } from './a.js';\nexport * from './b';\nconst c = import('./c');\nrequire('./a');\nimport '@workspace/core/tools';\nimport '@workspace/core/feature';\nimport(computed);`,
    },
    { path: "app/a.ts", text: "" },
    { path: "app/b/index.ts", text: "" },
    { path: "app/c.tsx", text: "" },
    { path: "app/fake.ts", text: "" },
    {
      path: "packages/core/package.json",
      text: JSON.stringify({
        name: "@workspace/core",
        exports: {
          "./tools": { types: "./src/tools.ts", import: "./src/tools.ts" },
          "./*": "./src/*.ts",
        },
      }),
    },
    { path: "packages/core/src/tools.ts", text: "" },
    { path: "packages/core/src/feature.ts", text: "" },
  ]);
  expect(dependencies.get("app/main.ts")).toEqual([
    "app/a.ts",
    "app/b/index.ts",
    "app/c.tsx",
    "packages/core/src/feature.ts",
    "packages/core/src/tools.ts",
  ]);
});

it("requires contiguous accepted source ranges with matching fingerprints for full coverage", () => {
  const scopes = [
    scope("first", "a.ts"),
    {
      ...scope("second", "b.ts"),
      inspectedSources: [{ path: "b.ts", startLine: 6, endLine: 10, fingerprint: "original" }],
    },
  ];
  const coverage = codebaseCoverage(
    [file("a.ts"), file("b.ts"), { ...file("c.ts"), fingerprint: "changed" }],
    scopes,
  );
  expect(coverage.get("a.ts")).toEqual({ inspected: true, nextLine: 11 });
  expect(coverage.get("b.ts")).toEqual({ inspected: false, nextLine: 1 });
  expect(coverage.get("c.ts")).toEqual({ inspected: false, nextLine: 1 });
  scopes.push({
    ...scope("gap", "b.ts"),
    inspectedSources: [{ path: "b.ts", startLine: 1, endLine: 5, fingerprint: "original" }],
  });
  expect(codebaseCoverage([file("b.ts")], scopes).get("b.ts")?.inspected).toBe(true);
});

it("retains dependency resolution after source text is evicted from the input memory budget", () => {
  const files = [
    { path: "app.ts", text: "import '@workspace/core';" },
    { path: "core/package.json", text: '{"name":"@workspace/core","exports":"./main.ts"}' },
    { path: "core/main.ts", text: "export const value = 1;" },
  ];
  const references = new Map(files.map((file) => [file.path, codebaseModuleReferences(file)]));
  const packages = files.flatMap((file) => {
    const pkg = codebaseWorkspacePackage(file);
    return pkg ? [pkg] : [];
  });
  expect(
    codebaseDependencies(
      files.map((file) => ({ path: file.path, text: null })),
      files.map((file) => file.path),
      { references, packages },
    ).get("app.ts"),
  ).toEqual(["core/main.ts"]);
});

it("propagates changed and deleted dependencies transitively through cycles and keeps unrelated maps current", () => {
  const files = [
    file("app.ts", ["middle.ts"]),
    file("middle.ts", ["data.ts", "app.ts"]),
    file("data.ts"),
    file("other.ts"),
  ];
  const index: CodebaseIndex = {
    version: 1,
    files,
    scopes: [
      scope("app", "app.ts", ["app.ts", "middle.ts", "data.ts"]),
      scope("other", "other.ts"),
    ],
  };
  const current = files.map((file) =>
    file.path === "data.ts" ? { ...file, fingerprint: "new", sha256: "new" } : file,
  );
  const report = codebaseIndexReport(index, current, "config", "current", "data");
  expect(report.changedFiles).toBe(1);
  expect(report.staleScopes).toBe(1);
  expect(report.files[0]).toMatchObject({
    change: "modified",
    previousSha256: "original",
    sha256: "new",
    affectedFiles: ["app.ts", "middle.ts"],
  });
  expect(
    codebaseIndexReport(
      index,
      files.filter((file) => file.path !== "data.ts"),
      "config",
      "current",
      "data",
    ).files[0]?.change,
  ).toBe("deleted");
  expect(
    codebaseIndexReport(index, current, "config", "current", "other").files[0]?.affectedScopes.map(
      (scope) => scope.scopeId,
    ),
  ).toEqual(["other"]);
});

it("bounds file pages while counting the full inventory", () => {
  const files = Array.from({ length: 123 }, (_, index) =>
    file(`src/${String(index).padStart(3, "0")}.ts`),
  );
  const report = codebaseIndexReport(
    { version: 1, files, scopes: [] },
    files,
    "config",
    "current",
    "src/",
    50,
  );
  expect(report.files).toHaveLength(50);
  expect(report.matchingFiles).toBe(123);
  expect(report.files[0]?.path).toBe("src/050.ts");
});

it("detects transitive dependency changes without storing a transitive file snapshot in every scope", () => {
  const files = [file("app.ts", ["middle.ts"]), file("middle.ts", ["data.ts"]), file("data.ts")];
  const document = {
    version: 1 as const,
    scopeId: "detail",
    parentScopeId: "overview",
    sourceFingerprint: "old",
    configurationFingerprint: "config",
    graph: { title: "App", summary: "App", nodes: [], edges: [], omissions: [] },
    inspectedSources: [{ path: "app.ts", startLine: 1, endLine: 10, fingerprint: "original" }],
    coverage: { inventoryFiles: 3, referencedFiles: 1, omittedFiles: 2 },
    provenance: {
      analyzer: { driverKind: ProviderDriverKind.make("codex"), model: "test" },
      promptVersion: 1 as const,
    },
  };
  const saved = indexedScope(document, files);
  expect(saved.inputs.map((input) => input.path)).toEqual(["app.ts", "middle.ts"]);
  const current = new Map(files.map((file) => [file.path, file]));
  expect(isIndexedScopeCurrent(saved, current, "config", "current")).toBe(true);
  current.set("data.ts", { ...file("data.ts"), fingerprint: "changed" });
  expect(isIndexedScopeCurrent(saved, current, "config", "current")).toBe(false);
});

it("retires removed child layers and obsolete source slices when source is refreshed", () => {
  const files = [file("a.ts"), file("other.ts")];
  const index: CodebaseIndex = {
    version: 1,
    files,
    scopes: [
      scope("removed_child", "a.ts"),
      {
        ...scope("old_slice", "a.ts"),
        parentScopeId: null,
        sourceRange: { path: "a.ts", startLine: 5 },
      },
      {
        ...scope("kept_slice", "other.ts"),
        parentScopeId: null,
        sourceRange: { path: "other.ts", startLine: 1 },
      },
    ],
  };
  const current = files.map((file) =>
    file.path === "a.ts" ? { ...file, fingerprint: "new", sha256: "new" } : file,
  );
  const root: CodebaseScope = {
    version: 1,
    scopeId: "overview",
    parentScopeId: null,
    sourceFingerprint: "new",
    configurationFingerprint: "config",
    graph: { title: "Overview", summary: "Overview", nodes: [], edges: [], omissions: [] },
    inspectedSources: [{ path: "a.ts", startLine: 1, endLine: 10, fingerprint: "new" }],
    coverage: { inventoryFiles: 2, referencedFiles: 1, omittedFiles: 1 },
    provenance: {
      analyzer: { driverKind: ProviderDriverKind.make("codex"), model: "test" },
      promptVersion: 1,
    },
  };
  expect(updateCodebaseIndex(index, root, current).scopes.map((scope) => scope.scopeId)).toEqual([
    "kept_slice",
    "overview",
  ]);
});
