import { createSourceFingerprint } from "./CodebaseFingerprint.ts";
import {
  buildCodebaseInput,
  codebaseSourcePriority,
  isExcludedCodebaseSource,
} from "./CodebaseInput.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import {
  CODEBASE_DIRECTORY,
  CODEBASE_LIMITS,
  CodebaseError,
  CodebaseGraph,
  CodebaseManifest,
  CodebaseScope,
  CodebaseScopeId,
  type CodebaseAnalyzer,
  type CodebaseAnalyzers,
  type CodebaseSnapshot,
  type CodebaseSource,
  type CodebaseNode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { withCheckoutLock } from "../vcs/CheckoutLock.ts";
import { VcsProcess } from "../vcs/VcsProcess.ts";

const isScopeId = Schema.is(CodebaseScopeId);
const isCodebaseError = Schema.is(CodebaseError);
const digest = (value: string | Buffer) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
async function sourceFileDigest(path: string) {
  const hash = createSourceFingerprint();
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk);
  return hash.digest();
}
const error = (code: CodebaseError["code"], message: string) =>
  new CodebaseError({ code, message });
const io = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => (isCodebaseError(cause) ? cause : error("io", String(cause))),
  });
const serialize = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
export const codebaseDocumentRevision = (document: CodebaseScope) => digest(serialize(document));
const isMissing = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
export interface CodebaseBinding {
  readonly checkout: string;
  readonly gitDirectory: string;
  readonly scopeId: string;
  readonly parentScopeId: string | null;
  readonly expectedRevision: string | null;
  readonly configurationRevision: string | null;
  readonly parentRevision: string | null;
  readonly sourceFingerprint: string;
  readonly gitHead: string;
  readonly gitBranch: string | null;
  readonly projectPath: string;
  readonly configurationFingerprint: string;
  readonly inventory: ReadonlyArray<{ path: string; fingerprint: string; text: string | null }>;
  readonly omittedFiles: number;
  readonly focus: CodebaseNode | null;
  readonly previousScope: CodebaseScope | null;
  readonly parentNodes: ReadonlyArray<CodebaseNode>;
  readonly previousNodes: ReadonlyArray<CodebaseNode>;
}

async function safePath(
  checkout: string,
  relative: string,
  create = false,
  checkedParents?: Set<string>,
) {
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === ".." || part === "." || /[:\\\0]/.test(part))) {
    throw error("invalid", "Invalid project-relative path.");
  }
  let current = checkout;
  for (let index = 0; index < parts.length; index++) {
    current = NodePath.join(current, parts[index]!);
    if (create && index < parts.length - 1)
      await NodeFSP.mkdir(current).catch((cause) => {
        if (
          !(
            typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            cause.code === "EEXIST"
          )
        )
          throw cause;
      });
    if (index < parts.length - 1 && checkedParents?.has(current)) continue;
    const stat = await NodeFSP.lstat(current).catch((cause) => {
      if (isMissing(cause)) return null;
      throw cause;
    });
    if (stat?.isDirectory() && index < parts.length - 1) checkedParents?.add(current);
    if (stat?.isSymbolicLink())
      throw error(
        "invalid",
        `Symbolic links are not supported in codebase artifacts or source anchors: ${relative}`,
      );
  }
  return current;
}

async function readText(checkout: string, relative: string) {
  const path = await safePath(checkout, relative);
  try {
    const handle = await NodeFSP.open(path, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > CODEBASE_LIMITS.documentBytes)
        throw error(
          "invalid",
          `Map file exceeds the ${CODEBASE_LIMITS.documentBytes}-byte limit: ${relative}`,
        );
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw cause;
  }
}
const scopeFile = (scopeId: string) => {
  if (!isScopeId(scopeId)) throw error("invalid", "Invalid scope identity.");
  return `${CODEBASE_DIRECTORY}/scopes/${scopeId}.json`;
};
const manifestFile = `${CODEBASE_DIRECTORY}/manifest.json`;
const revision = (text: string | null) => (text === null ? null : digest(text));
const decodeVersionEnvelope = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ version: Schema.optional(Schema.Number) })),
);
const decode = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  text: string,
): S["Type"] => {
  try {
    const envelope = decodeVersionEnvelope(text);
    if (envelope.version !== undefined && envelope.version !== 1)
      throw error("unsupported", "This map schema is not supported by this version of T3 Code.");
    return Schema.decodeUnknownSync(Schema.fromJsonString(schema))(text, {
      onExcessProperty: "error",
    });
  } catch (cause) {
    if (isCodebaseError(cause)) throw cause;
    throw error(
      "invalid",
      `Invalid map document: ${String(cause).slice(0, 800)}. Resolve the file or retry the analysis.`,
    );
  }
};

async function replace(checkout: string, relative: string, text: string) {
  const destination = await safePath(checkout, relative, true);
  const temporary = `${destination}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    const handle = await NodeFSP.open(temporary, "wx");
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await NodeFSP.rename(temporary, destination);
  } finally {
    await NodeFSP.unlink(temporary).catch((cause) => {
      if (!isMissing(cause)) throw cause;
    });
  }
}

export class CodebaseArtifactStore extends Context.Service<
  CodebaseArtifactStore,
  {
    readonly read: (input: {
      checkout: string;
      scopeId: string;
    }) => Effect.Effect<CodebaseSnapshot, CodebaseError>;
    readonly prepare: (input: {
      checkout: string;
      scopeId: string;
      parentScopeId: string | null;
    }) => Effect.Effect<CodebaseBinding, CodebaseError>;
    readonly validate: (
      binding: CodebaseBinding,
      output: string,
      analyzer: CodebaseAnalyzer,
    ) => Effect.Effect<CodebaseScope, CodebaseError>;
    readonly publish: (
      binding: CodebaseBinding,
      document: CodebaseScope,
    ) => Effect.Effect<string, CodebaseError>;
    readonly configure: (
      checkout: string,
      expectedRevision: string | null,
      analyzers: CodebaseAnalyzers,
    ) => Effect.Effect<void, CodebaseError>;
  }
>()("t3/codebase/CodebaseArtifactStore") {
  static readonly layer = Layer.effect(
    CodebaseArtifactStore,
    Effect.gen(function* () {
      const vcs = yield* VcsProcess;
      const git = (checkout: string, args: string[], allowNonZeroExit = false) =>
        vcs
          .run({
            operation: "codebase",
            command: "git",
            args,
            cwd: checkout,
            allowNonZeroExit,
            maxOutputBytes: 4 * 1024 * 1024,
          })
          .pipe(Effect.mapError((cause) => error("unsupported", cause.message)));

      const prepare = Effect.fn("CodebaseArtifactStore.prepare")(function* (input: {
        checkout: string;
        scopeId: string;
        parentScopeId: string | null;
      }) {
        const checkout = yield* io(() => NodeFSP.realpath(input.checkout));
        const root = (yield* git(checkout, ["rev-parse", "--show-toplevel"])).stdout.trim();
        const gitDirectory = (yield* git(checkout, [
          "rev-parse",
          "--absolute-git-dir",
        ])).stdout.trim();
        const head = (yield* git(checkout, ["rev-parse", "HEAD"])).stdout.trim();
        const branch =
          (yield* git(checkout, ["symbolic-ref", "--short", "-q", "HEAD"], true)).stdout.trim() ||
          null;
        const paths = (yield* git(checkout, [
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
          "--",
          ".",
        ])).stdout.split("\0");
        const files = [
          ...new Set(paths.filter((path) => path && !isExcludedCodebaseSource(path))),
        ].sort();
        if (files.length > CODEBASE_LIMITS.sourceFiles)
          return yield* error(
            "unsupported",
            "This project exceeds the 20,000 source-file inventory limit. Select a smaller project root.",
          );
        const focusText = input.parentScopeId
          ? yield* io(() => readText(checkout, scopeFile(input.parentScopeId!)))
          : null;
        const focus = focusText ? yield* io(async () => decode(CodebaseScope, focusText)) : null;
        const focusPaths =
          focus?.graph.nodes
            .find((node) => node.childScopeId === input.scopeId)
            ?.sources.map((source) => source.path) ?? [];
        files.sort(
          (a, b) =>
            codebaseSourcePriority(a, focusPaths) - codebaseSourcePriority(b, focusPaths) ||
            a.localeCompare(b),
        );
        const inventory = yield* io(async () => {
          let retainedBytes = 0;
          const checkedParents = new Set<string>();
          const items: Array<{ path: string; fingerprint: string; text: string | null }> = [];
          for (let offset = 0; offset < files.length; offset += 8) {
            const batch = await Promise.all(
              files.slice(offset, offset + 8).map(async (path) => {
                let absolute: string;
                try {
                  absolute = await safePath(checkout, path, false, checkedParents);
                } catch (cause) {
                  if (!isCodebaseError(cause)) throw cause;
                  return {
                    path,
                    fingerprint: `symlink:${await NodeFSP.readlink(NodePath.join(checkout, path)).catch(() => "unavailable")}`,
                    text: null,
                  };
                }
                const stat = await NodeFSP.stat(absolute).catch((cause) => {
                  if (isMissing(cause)) return null;
                  throw cause;
                });
                if (!stat) return { path, fingerprint: "deleted", text: null };
                if (!stat.isFile()) return { path, fingerprint: "not-file", text: null };
                if (stat.size > CODEBASE_LIMITS.sourceFileBytes)
                  return { path, fingerprint: await sourceFileDigest(absolute), text: null };
                const content = await NodeFSP.readFile(absolute);
                const hash = createSourceFingerprint();
                hash.update(content);
                return {
                  path,
                  fingerprint: hash.digest(),
                  text: content.includes(0) ? null : content.toString("utf8"),
                };
              }),
            );
            for (const item of batch) {
              const bytes = item.text === null ? 0 : Buffer.byteLength(item.text);
              const retain = retainedBytes + bytes <= 8 * 1024 * 1024;
              items.push({ ...item, text: retain ? item.text : null });
              if (retain) retainedBytes += bytes;
            }
          }
          return items.sort((a, b) => a.path.localeCompare(b.path));
        });
        const manifestText = yield* io(() => readText(checkout, manifestFile));
        const manifest =
          manifestText === null
            ? null
            : yield* io(async () => decode(CodebaseManifest, manifestText));
        const scopeText = yield* io(() => readText(checkout, scopeFile(input.scopeId)));
        const previousScope =
          scopeText !== null ? yield* io(async () => decode(CodebaseScope, scopeText)) : null;
        const parentText =
          input.parentScopeId === null
            ? null
            : yield* io(() => readText(checkout, scopeFile(input.parentScopeId!)));
        if (input.parentScopeId !== null) {
          if (!parentText)
            return yield* error("invalid", "Build the parent scope before this layer.");
          const parent = yield* io(async () => decode(CodebaseScope, parentText));
          if (!parent.graph.nodes.some((node) => node.childScopeId === input.scopeId))
            return yield* error("invalid", "The parent no longer contains this child scope.");
        }
        return {
          checkout,
          gitDirectory,
          scopeId: input.scopeId,
          parentScopeId: input.parentScopeId,
          expectedRevision: revision(scopeText),
          configurationRevision: revision(manifestText),
          parentRevision: revision(parentText),
          sourceFingerprint: digest(
            serialize(inventory.map(({ path, fingerprint }) => [path, fingerprint])),
          ),
          gitHead: head,
          gitBranch: branch,
          projectPath: NodePath.relative(root, checkout).replaceAll("\\", "/") || ".",
          configurationFingerprint: digest(serialize(manifest?.analyzers ?? {})),
          inventory,
          previousScope,
          parentNodes: focus?.graph.nodes ?? [],
          previousNodes: previousScope?.graph.nodes ?? [],
          focus: focus?.graph.nodes.find((node) => node.childScopeId === input.scopeId) ?? null,
          omittedFiles: inventory.filter((file) => file.text === null).length,
        } satisfies CodebaseBinding;
      });

      const read = Effect.fn("CodebaseArtifactStore.read")(function* (input: {
        checkout: string;
        scopeId: string;
      }) {
        const base: CodebaseSnapshot = {
          checkout: input.checkout,
          branch: null,
          head: null,
          state: "unbuilt",
          freshness: "unknown",
          revision: null,
          configurationRevision: null,
          manifest: null,
          scope: null,
          detail: null,
          ignored: false,
        };
        return yield* Effect.gen(function* () {
          const checkout = yield* io(() => NodeFSP.realpath(input.checkout));
          const text = yield* io(() => readText(checkout, scopeFile(input.scopeId)));
          const manifestText = yield* io(() => readText(checkout, manifestFile));
          const current = {
            ...base,
            checkout,
            revision: revision(text),
            configurationRevision: revision(manifestText),
          };
          if ([text, manifestText].some((value) => value?.includes("<<<<<<<")))
            return {
              ...current,
              state: "conflicted" as const,
              detail: "Resolve the map's Git conflict and reload.",
            };
          const manifest =
            manifestText === null
              ? null
              : yield* io(async () => decode(CodebaseManifest, manifestText));
          const scope = text === null ? null : yield* io(async () => decode(CodebaseScope, text));
          if (scope && scope.scopeId !== input.scopeId)
            return yield* error("invalid", "Scope identity does not match its filename.");
          if (!scope) {
            const head = (yield* git(checkout, ["rev-parse", "HEAD"])).stdout.trim();
            const branch =
              (yield* git(
                checkout,
                ["symbolic-ref", "--short", "-q", "HEAD"],
                true,
              )).stdout.trim() || null;
            const ignored =
              (yield* git(
                checkout,
                ["check-ignore", "-q", `${CODEBASE_DIRECTORY}/manifest.json`],
                true,
              )).exitCode === 0;
            return { ...current, manifest, head, branch, ignored };
          }
          const prepared = yield* Effect.result(prepare({ ...input, parentScopeId: null }));
          if (prepared._tag === "Failure")
            return {
              ...current,
              manifest,
              scope,
              state: scope ? ("ready" as const) : ("unsupported" as const),
              detail: prepared.failure.message,
            };
          const binding = prepared.success;
          const ignored =
            (yield* git(
              checkout,
              ["check-ignore", "-q", `${CODEBASE_DIRECTORY}/manifest.json`],
              true,
            )).exitCode === 0;
          return {
            ...current,
            manifest,
            scope,
            branch: binding.gitBranch,
            head: binding.gitHead,
            ignored,
            state: scope ? ("ready" as const) : ("unbuilt" as const),
            freshness: scope
              ? scope.sourceFingerprint === binding.sourceFingerprint &&
                scope.configurationFingerprint === binding.configurationFingerprint
                ? ("current" as const)
                : ("stale" as const)
              : ("unknown" as const),
          };
        }).pipe(
          Effect.catch((cause) =>
            Effect.succeed({
              ...base,
              state:
                cause.code === "invalid"
                  ? ("invalid" as const)
                  : cause.code === "unsupported"
                    ? ("unsupported" as const)
                    : ("inaccessible" as const),
              detail: cause.message,
            }),
          ),
        );
      });

      const validate = Effect.fn("CodebaseArtifactStore.validate")(function* (
        binding: CodebaseBinding,
        output: string,
        analyzer: CodebaseAnalyzer,
      ) {
        if (Buffer.byteLength(output) > CODEBASE_LIMITS.documentBytes)
          return yield* error("invalid", "Analysis output exceeds the map document limit.");
        const json = output
          .trim()
          .replace(/^```(?:json)?\s*\n/, "")
          .replace(/\n```$/, "");
        const graph = yield* io(async () => decode(CodebaseGraph, json));
        const bundle = buildCodebaseInput(binding);
        const sourceByPath = new Map(binding.inventory.map((file) => [file.path, file]));
        const reference = (source: CodebaseSource) => {
          const file = sourceByPath.get(source.path);
          const excerpt = bundle.supplied.find((item) => item.path === source.path);
          if (
            !file?.text ||
            !excerpt ||
            source.startLine < excerpt.startLine ||
            source.endLine > excerpt.endLine
          )
            throw error(
              "invalid",
              `Invalid source anchor: ${source.path}:${source.startLine}-${source.endLine}`,
            );
          return { ...source, fingerprint: file.fingerprint };
        };
        for (const node of graph.nodes) {
          if (node.boundaryScopeId) {
            const boundary = yield* io(() =>
              readText(binding.checkout, scopeFile(node.boundaryScopeId!)),
            );
            if (!boundary)
              return yield* error(
                "invalid",
                "A cross-scope boundary must refer to an existing scope.",
              );
            yield* io(async () => decode(CodebaseScope, boundary));
          }
        }
        return yield* io(async () => {
          const identities = new Map(
            graph.nodes.map((node) => [
              node.id,
              binding.previousNodes.find((old) => old.id === node.id)?.id ??
                binding.previousNodes.find(
                  (old) =>
                    node.sources.length > 0 &&
                    old.kind === node.kind &&
                    JSON.stringify(
                      old.sources.map((source) => [source.path, source.symbol ?? old.name]).sort(),
                    ) ===
                      JSON.stringify(
                        node.sources
                          .map((source) => [source.path, source.symbol ?? node.name])
                          .sort(),
                      ),
                )?.id ??
                `n_${digest(
                  node.sources.length
                    ? node.sources
                        .map((source) => `${source.path}#${source.symbol ?? node.name}`)
                        .sort()
                        .join("|") + `:${node.kind}:${binding.scopeId}`
                    : `${binding.scopeId}:${node.id}`,
                ).slice(0, 24)}`,
            ]),
          );
          const nodes = graph.nodes
            .map((node) => ({
              ...node,
              id: identities.get(node.id)!,
              sources: node.sources.map(reference),
              ...(node.expandable ? { childScopeId: `scope_${identities.get(node.id)!}` } : {}),
            }))
            .sort((a, b) => a.id.localeCompare(b.id));
          const edges = graph.edges
            .map((edge) => ({
              ...edge,
              from: identities.get(edge.from)!,
              to: identities.get(edge.to)!,
              id: `e_${digest(`${identities.get(edge.from)}:${edge.kind}:${identities.get(edge.to)}:${edge.label}`).slice(0, 24)}`,
              sources: edge.sources.map(reference),
            }))
            .sort((a, b) => a.id.localeCompare(b.id));
          const document = {
            version: 1 as const,
            scopeId: binding.scopeId,
            parentScopeId: binding.parentScopeId,
            graph: { ...graph, nodes, edges },
            sourceFingerprint: binding.sourceFingerprint,
            configurationFingerprint: binding.configurationFingerprint,
            coverage: {
              inventoryFiles: binding.inventory.length,
              referencedFiles: new Set(
                [
                  ...nodes.flatMap((node) => node.sources),
                  ...edges.flatMap((edge) => edge.sources),
                ].map((source) => source.path),
              ).size,
              omittedFiles: bundle.omittedFiles,
              truncatedFiles: bundle.supplied.filter((file) => file.truncated).length,
            },
            provenance: { analyzer, promptVersion: 1 as const },
          };
          const previous = binding.previousScope;
          if (
            previous &&
            previous.sourceFingerprint === document.sourceFingerprint &&
            previous.configurationFingerprint === document.configurationFingerprint &&
            serialize(previous.graph) === serialize(document.graph) &&
            serialize(previous.coverage) === serialize(document.coverage)
          )
            return previous;
          return decode(CodebaseScope, serialize(document));
        });
      });

      const publish = Effect.fn("CodebaseArtifactStore.publish")(function* (
        binding: CodebaseBinding,
        document: CodebaseScope,
      ) {
        return yield* withCheckoutLock(
          binding.gitDirectory,
          Effect.gen(function* () {
            const current = yield* prepare(binding);
            if (
              [
                "sourceFingerprint",
                "gitHead",
                "gitBranch",
                "expectedRevision",
                "configurationRevision",
                "parentRevision",
              ].some(
                (key) =>
                  current[key as keyof CodebaseBinding] !== binding[key as keyof CodebaseBinding],
              )
            ) {
              return yield* error(
                "conflict",
                "Source, checkout, configuration, or map changed during analysis. Start a new pass.",
              );
            }
            const accepted = yield* io(async () => {
              const target = scopeFile(binding.scopeId);
              const text = serialize(document);
              if (Buffer.byteLength(text) > CODEBASE_LIMITS.documentBytes)
                throw error("invalid", "Map document is too large.");
              if (
                revision(await readText(binding.checkout, target)) !== binding.expectedRevision ||
                revision(await readText(binding.checkout, manifestFile)) !==
                  binding.configurationRevision ||
                (binding.parentScopeId !== null &&
                  revision(await readText(binding.checkout, scopeFile(binding.parentScopeId))) !==
                    binding.parentRevision)
              )
                throw error("conflict", "The destination changed before publication.");
              if (binding.configurationRevision === null)
                await replace(
                  binding.checkout,
                  manifestFile,
                  serialize({
                    version: 1,
                    projectPath: binding.projectPath,
                    rootScopeId: "overview",
                    analyzers: {},
                  }),
                );
              if (revision(text) !== binding.expectedRevision)
                await replace(binding.checkout, target, text);
              return digest(text);
            });
            const after = yield* prepare(binding);
            if (
              after.gitHead !== binding.gitHead ||
              after.gitBranch !== binding.gitBranch ||
              after.sourceFingerprint !== binding.sourceFingerprint ||
              after.expectedRevision !== accepted
            ) {
              return yield* error(
                "conflict",
                "The checkout changed during publication. Reload to inspect the current files; no source was rolled back.",
              );
            }
            return accepted;
          }),
        ).pipe(
          Effect.mapError((cause) =>
            isCodebaseError(cause) ? cause : error("busy", cause.message),
          ),
        );
      });

      const configure = Effect.fn("CodebaseArtifactStore.configure")(function* (
        checkout: string,
        expectedRevision: string | null,
        analyzers: CodebaseAnalyzers,
      ) {
        const binding = yield* prepare({ checkout, scopeId: "overview", parentScopeId: null });
        return yield* withCheckoutLock(
          binding.gitDirectory,
          Effect.gen(function* () {
            const current = yield* prepare(binding);
            if (current.gitHead !== binding.gitHead || current.gitBranch !== binding.gitBranch)
              return yield* error(
                "conflict",
                "The checkout changed before AI setup could be saved.",
              );
            yield* io(async () => {
              if (revision(await readText(binding.checkout, manifestFile)) !== expectedRevision)
                throw error(
                  "conflict",
                  "AI setup changed in another client. Reload before saving.",
                );
              const manifest = decode(
                CodebaseManifest,
                serialize({
                  version: 1,
                  projectPath: binding.projectPath,
                  rootScopeId: "overview",
                  analyzers,
                }),
              );
              await replace(binding.checkout, manifestFile, serialize(manifest));
            });
          }),
        ).pipe(
          Effect.mapError((cause) =>
            isCodebaseError(cause) ? cause : error("busy", cause.message),
          ),
        );
      });
      return { read, prepare, validate, publish, configure };
    }),
  );
}
