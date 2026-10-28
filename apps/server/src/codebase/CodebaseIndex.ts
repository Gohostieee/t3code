// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import {
  CodebaseScopeId,
  CodebaseRelativePath,
  CodebaseSource,
  CodebaseSourceRange,
  type CodebaseIndexReport,
  type CodebaseScope,
} from "@t3tools/contracts";

export const IndexedFile = Schema.Struct({
  path: CodebaseRelativePath,
  sha256: Schema.NullOr(Schema.String),
  fingerprint: Schema.String,
  lines: Schema.Number,
  exclusion: Schema.NullOr(Schema.String),
  dependsOn: Schema.Array(CodebaseRelativePath),
});
export type IndexedFile = typeof IndexedFile.Type;
const IndexedScope = Schema.Struct({
  scopeId: CodebaseScopeId,
  parentScopeId: Schema.NullOr(CodebaseScopeId),
  title: Schema.String,
  sourceFingerprint: Schema.String,
  configurationFingerprint: Schema.String,
  dependencyFingerprint: Schema.optional(Schema.String),
  inspectedSources: Schema.Array(CodebaseSource),
  inputs: Schema.Array(
    Schema.Struct({
      path: CodebaseRelativePath,
      fingerprint: Schema.String,
      sha256: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  childScopeIds: Schema.optional(Schema.Array(CodebaseScopeId)),
  sourceRange: Schema.optional(CodebaseSourceRange),
});
export const CodebaseIndex = Schema.Struct({
  version: Schema.Literal(1),
  files: Schema.Array(IndexedFile),
  scopes: Schema.Array(IndexedScope),
});
export type CodebaseIndex = typeof CodebaseIndex.Type;
export const emptyCodebaseIndex = (): CodebaseIndex => ({ version: 1, files: [], scopes: [] });

export function codebaseModuleReferences(file: { path: string; text: string | null }) {
  if (!file.text || !/\.[cm]?[jt]sx?$/.test(file.path)) return [];
  // Consume comments and strings as tokens so examples inside them cannot become imports.
  const tokens = [
    ...file.text.matchAll(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g,
    ),
  ]
    .map((match) => match[0])
    .filter((token) => !token.startsWith("//") && !token.startsWith("/*"));
  const references = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    let specifier: string | undefined;
    if ((token === "require" || token === "import") && tokens[i + 1] === "(")
      specifier = tokens[i + 2];
    else if (token === "import" && /^["']/.test(tokens[i + 1] ?? "")) specifier = tokens[i + 1];
    else if (token === "from") specifier = tokens[i + 1];
    if (specifier && /^["']/.test(specifier))
      references.add(Buffer.from(specifier.slice(1, -1)).toString("utf8"));
  }
  return [...references];
}

export function codebaseWorkspacePackage(file: { path: string; text: string | null }) {
  if (!/(^|\/)package.json$/.test(file.path) || !file.text) return null;
  try {
    const value: unknown = JSON.parse(file.text);
    if (
      typeof value !== "object" ||
      value === null ||
      !("name" in value) ||
      typeof value.name !== "string"
    )
      return null;
    return {
      name: value.name,
      root: NodePath.posix.dirname(file.path),
      exports: "exports" in value ? value.exports : null,
      ...("main" in value && typeof value.main === "string" ? { main: value.main } : {}),
    };
  } catch {
    return null;
  }
}

/** Literal module references only; runtime dispatch and computed imports remain unknown. */
export function codebaseDependencies(
  files: ReadonlyArray<{ path: string; text: string | null }>,
  allPaths?: readonly string[],
  metadata?: {
    references: ReadonlyMap<string, readonly string[]>;
    packages: ReadonlyArray<NonNullable<ReturnType<typeof codebaseWorkspacePackage>>>;
  },
) {
  const paths = new Set(allPaths ?? files.map((file) => file.path));
  const packages = new Map(
    (
      metadata?.packages ??
      files.flatMap((file) => {
        const pkg = codebaseWorkspacePackage(file);
        return pkg ? [pkg] : [];
      })
    ).map((pkg) => [pkg.name, pkg]),
  );
  const resolve = (base: string) => {
    const normalized = NodePath.posix.normalize(base).replace(/^\.\//, "");
    const stem = normalized.replace(/\.[cm]?jsx?$/, "");
    return [
      normalized,
      ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css"].flatMap(
        (extension) => [stem + extension, `${normalized}/index${extension}`],
      ),
    ].find((candidate) => paths.has(candidate));
  };
  const target = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      for (const key of ["source", "import", "default", "require", "types"]) {
        if (key in value) {
          const result = target(value[key as keyof typeof value]);
          if (result) return result;
        }
      }
    }
    return undefined;
  };
  return new Map(
    files.map((file) => {
      const dependencies = new Set<string>();
      for (const name of metadata?.references.get(file.path) ?? codebaseModuleReferences(file)) {
        let dependency: string | undefined;
        if (name.startsWith("."))
          dependency = resolve(NodePath.posix.join(NodePath.posix.dirname(file.path), name));
        else {
          const packageName = name.startsWith("@")
            ? name.split("/").slice(0, 2).join("/")
            : name.split("/")[0]!;
          const pkg = packages.get(packageName);
          if (pkg) {
            const subpath = name.slice(packageName.length);
            const key = subpath ? `.${subpath}` : ".";
            const exports = pkg.exports;
            let destination =
              exports && typeof exports === "object" && key in exports
                ? target(exports[key as keyof typeof exports])
                : subpath
                  ? undefined
                  : target(exports);
            if (!destination && exports && typeof exports === "object") {
              for (const [pattern, value] of Object.entries(exports)) {
                const [prefix, suffix] = pattern.split("*");
                if (suffix !== undefined && key.startsWith(prefix!) && key.endsWith(suffix)) {
                  destination = target(value)?.replaceAll(
                    "*",
                    key.slice(prefix!.length, suffix ? -suffix.length : undefined),
                  );
                  if (destination) break;
                }
              }
            }
            dependency = resolve(
              NodePath.posix.join(
                pkg.root,
                destination ?? (subpath ? subpath.slice(1) : (pkg.main ?? "index")),
              ),
            );
          }
        }
        if (dependency && dependency !== file.path) dependencies.add(dependency);
      }
      return [file.path, [...dependencies].sort()] as const;
    }),
  );
}

function dependencyFingerprint(paths: Iterable<string>, byPath: ReadonlyMap<string, IndexedFile>) {
  const reachable = new Set(paths);
  for (const path of reachable)
    for (const dependency of byPath.get(path)?.dependsOn ?? []) reachable.add(dependency);
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(
        [...reachable].sort().map((path) => [path, byPath.get(path)?.fingerprint ?? "deleted"]),
      ),
    )
    .digest("hex");
}

export function indexedScope(scope: CodebaseScope, files: readonly IndexedFile[]) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const suppliedPaths = (
    scope.inspectedSources ?? scope.graph.nodes.flatMap((node) => node.sources)
  ).map((source) => source.path);
  const paths = new Set(suppliedPaths);
  for (const path of suppliedPaths)
    for (const dependency of byPath.get(path)?.dependsOn ?? []) paths.add(dependency);
  return {
    scopeId: scope.scopeId,
    parentScopeId: scope.parentScopeId,
    title: scope.graph.title,
    sourceFingerprint: scope.sourceFingerprint,
    configurationFingerprint: scope.configurationFingerprint,
    dependencyFingerprint: dependencyFingerprint(paths, byPath),
    inspectedSources: scope.inspectedSources ?? [],
    childScopeIds: scope.graph.nodes.flatMap((node) =>
      node.childScopeId && !node.boundaryScopeId ? [node.childScopeId] : [],
    ),
    ...(scope.sourceRange ? { sourceRange: scope.sourceRange } : {}),
    inputs: [...paths].sort().map((path) => ({
      path,
      fingerprint: byPath.get(path)?.fingerprint ?? "deleted",
      sha256: byPath.get(path)?.sha256 ?? null,
    })),
  };
}

export function updateCodebaseIndex(
  index: CodebaseIndex,
  scope: CodebaseScope,
  files: readonly IndexedFile[],
): CodebaseIndex {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const candidates = [
    ...index.scopes.filter((entry) => entry.scopeId !== scope.scopeId),
    indexedScope(scope, files),
  ];
  const roots = candidates.filter((entry) => {
    if (entry.parentScopeId !== null) return false;
    if (!entry.sourceRange) return true;
    const file = byPath.get(entry.sourceRange.path);
    return (
      !!file &&
      entry.sourceRange.startLine <= file.lines &&
      entry.inputs.find((input) => input.path === file.path)?.fingerprint === file.fingerprint
    );
  });
  const retained = new Set(roots.map((entry) => entry.scopeId));
  const byId = new Map(candidates.map((entry) => [entry.scopeId, entry]));
  const byParent = new Map<string, typeof candidates>();
  for (const entry of candidates)
    if (entry.parentScopeId !== null) {
      const siblings = byParent.get(entry.parentScopeId) ?? [];
      siblings.push(entry);
      byParent.set(entry.parentScopeId, siblings);
    }
  for (const id of retained) {
    const parent = byId.get(id)!;
    for (const child of byParent.get(id) ?? [])
      if (!parent.childScopeIds || parent.childScopeIds.includes(child.scopeId))
        retained.add(child.scopeId);
  }
  return {
    version: 1,
    files,
    scopes: candidates
      .filter((entry) => retained.has(entry.scopeId))
      .sort((a, b) => a.scopeId.localeCompare(b.scopeId)),
  };
}

export function isIndexedScopeCurrent(
  scope: CodebaseIndex["scopes"][number],
  files: ReadonlyMap<string, IndexedFile>,
  configurationFingerprint: string,
  sourceFingerprint: string,
) {
  return (
    scope.configurationFingerprint === configurationFingerprint &&
    (scope.scopeId === "overview"
      ? scope.sourceFingerprint === sourceFingerprint
      : scope.inputs.length > 0 &&
        scope.inputs.every(
          (input) => (files.get(input.path)?.fingerprint ?? "deleted") === input.fingerprint,
        ) &&
        (!scope.dependencyFingerprint ||
          scope.dependencyFingerprint ===
            dependencyFingerprint(
              scope.inputs.map((input) => input.path),
              files,
            )))
  );
}

export function codebaseCoverage(files: readonly IndexedFile[], scopes: CodebaseIndex["scopes"]) {
  const sources = new Map<string, CodebaseSource[]>();
  for (const scope of scopes)
    for (const source of scope.inspectedSources) {
      const list = sources.get(source.path) ?? [];
      list.push(source);
      sources.set(source.path, list);
    }
  return new Map(
    files.map((file) => {
      let nextLine = 1;
      for (const range of (sources.get(file.path) ?? [])
        .filter((source) => source.fingerprint === file.fingerprint)
        .sort((a, b) => a.startLine - b.startLine)) {
        if (range.startLine > nextLine) break;
        nextLine = Math.max(nextLine, range.endLine + 1);
      }
      return [file.path, { inspected: file.lines > 0 && nextLine > file.lines, nextLine }] as const;
    }),
  );
}

export function codebaseIndexReport(
  index: CodebaseIndex,
  files: readonly IndexedFile[],
  configurationFingerprint: string,
  sourceFingerprint: string,
  query = "",
  offset = 0,
  changedOnly = false,
): CodebaseIndexReport {
  const current = new Map(files.map((file) => [file.path, file]));
  const previous = new Map(index.files.map((file) => [file.path, file]));
  const staleInputs = new Map(
    index.scopes.flatMap((scope) =>
      scope.inputs
        .filter(
          (input) => input.fingerprint !== (current.get(input.path)?.fingerprint ?? "deleted"),
        )
        .map((input) => [input.path, input] as const),
    ),
  );
  const coverage = codebaseCoverage(files, index.scopes);
  const reverse = new Map<string, Set<string>>();
  for (const file of [...index.files, ...files])
    for (const dependency of file.dependsOn) {
      const dependents = reverse.get(dependency) ?? new Set<string>();
      dependents.add(file.path);
      reverse.set(dependency, dependents);
    }
  const affected = (seeds: Iterable<string>) => {
    const found = new Set(seeds);
    for (const path of found) for (const dependent of reverse.get(path) ?? []) found.add(dependent);
    return found;
  };
  const change = (path: string) =>
    !current.has(path)
      ? ("deleted" as const)
      : staleInputs.has(path)
        ? ("modified" as const)
        : !previous.has(path)
          ? index.files.length
            ? ("added" as const)
            : ("unindexed" as const)
          : current.get(path)!.sha256 !== previous.get(path)!.sha256
            ? ("modified" as const)
            : ("unchanged" as const);
  const paths = [...new Set([...previous.keys(), ...current.keys(), ...staleInputs.keys()])].sort();
  const changed = paths.filter((path) => ["added", "modified", "deleted"].includes(change(path)));
  const affectedFiles = affected(changed);
  const stale = index.scopes.filter(
    (scope) => !isIndexedScopeCurrent(scope, current, configurationFingerprint, sourceFingerprint),
  );
  const staleIds = new Set(stale.map((scope) => scope.scopeId));
  const matches = paths.filter(
    (path) =>
      path.toLowerCase().includes(query.toLowerCase()) &&
      (!changedOnly || change(path) !== "unchanged"),
  );
  return {
    totalFiles: files.length,
    inspectedFiles: files.filter((file) => coverage.get(file.path)?.inspected).length,
    excludedFiles: files.filter(
      (file) => file.exclusion !== null && file.exclusion !== "memory budget",
    ).length,
    changedFiles: changed.length,
    affectedFiles: affectedFiles.size,
    staleScopes: stale.length,
    totalScopes: index.scopes.length,
    matchingFiles: matches.length,
    offset,
    files: matches.slice(offset, offset + 50).map((path) => {
      const file = current.get(path);
      const old = previous.get(path);
      const dependents = affected([path]);
      dependents.delete(path);
      const affectedScopes = index.scopes.filter(
        (scope) =>
          scope.scopeId === "overview" ||
          scope.inputs.some((source) => source.path === path || dependents.has(source.path)),
      );
      return {
        path,
        sha256: file?.sha256 ?? null,
        previousSha256: staleInputs.get(path)?.sha256 ?? old?.sha256 ?? null,
        change: change(path),
        inspected: coverage.get(path)?.inspected ?? false,
        exclusion: file?.exclusion ?? null,
        dependsOn: (file?.dependsOn ?? old?.dependsOn ?? []).slice(0, 100),
        affectedFiles: [...dependents].sort().slice(0, 100),
        affectedFileCount: dependents.size,
        scopes: index.scopes
          .filter((scope) => scope.inspectedSources.some((source) => source.path === path))
          .map((scope) => ({ scopeId: scope.scopeId, title: scope.title }))
          .slice(0, 100),
        affectedScopes: affectedScopes
          .map((scope) => ({
            scopeId: scope.scopeId,
            title: scope.title,
            stale: staleIds.has(scope.scopeId),
          }))
          .slice(0, 100),
        affectedScopeCount: affectedScopes.length,
      };
    }),
  };
}
