// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeWorkerThreads from "node:worker_threads";
// @effect-diagnostics nodeBuiltinImport:off
import ts from "typescript";
import * as Schema from "effect/Schema";
import {
  CodebaseError,
  type AtlasApp,
  type AtlasDocument,
  type AtlasNode,
  type AtlasEdge,
} from "@t3tools/contracts";
import type { CodebaseBinding } from "./CodebaseArtifactStore.ts";
import { AtlasDocument as AtlasDocumentSchema } from "@t3tools/contracts";

export const atlasHash = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
export const atlasId = () => NodeCrypto.randomBytes(16).toString("hex");
export const ATLAS_EXTRACTOR_VERSION = `typescript-${ts.version}:atlas-4`;
const key = (...parts: string[]) => `a_${atlasHash(parts.join(":")).slice(0, 32)}`;
const slash = (value: string) => value.replaceAll("\\", "/");
const canonicalPath = (value: string) =>
  ts.sys.useCaseSensitiveFileNames ? slash(value) : slash(value).toLowerCase();
const script = /\.[cm]?[jt]sx?$/;
type Inventory = CodebaseBinding["inventory"];
export type AtlasSyntaxCache = {
  files: Map<string, { fingerprint: string; source: ts.SourceFile }>;
  bytes: number;
  reparsed?: number;
  reused?: number;
};
const PackageMetadata = Schema.Struct({
  name: Schema.optional(Schema.String),
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const decodePackage = Schema.decodeUnknownSync(PackageMetadata);
const isCodebaseError = Schema.is(CodebaseError);
const decodeDocument = Schema.decodeUnknownSync(AtlasDocumentSchema);

/** Reads only inventoried regular source; parser input is independent of provider bundle budgets. */
export async function atlasSource(checkout: string, path: string) {
  const absolute = NodePath.resolve(checkout, path);
  const real = await NodeFSP.realpath(absolute);
  const relative = NodePath.relative(checkout, real);
  if (relative.startsWith("..") || NodePath.isAbsolute(relative) || slash(relative) !== slash(path))
    throw new Error("Source path escapes checkout or uses a symlink.");
  const stat = await NodeFSP.stat(real);
  if (!stat.isFile() || stat.size > 1024 * 1024)
    throw new Error("Source exceeds the parser file budget.");
  return NodeFSP.readFile(real, "utf8");
}

export async function discoverAtlasApps(
  checkout: string,
  inventory: Inventory,
): Promise<AtlasApp[]> {
  const apps: AtlasApp[] = [];
  for (const file of inventory) {
    if (!/(^|\/)package.json$/.test(file.path) || file.exclusion) continue;
    try {
      const source = ts.parseConfigFileTextToJson(
        file.path,
        await atlasSource(checkout, file.path),
      );
      const pkg = decodePackage(source.config);
      const root = NodePath.posix.dirname(file.path);
      const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
      const next: unknown = dependencies.next;
      const tanstack: unknown = dependencies["@tanstack/react-router"];
      const prefix = root === "." ? "" : `${root}/`;
      const appRouter = inventory.some(
        (f) => f.path.startsWith(`${prefix}app/`) || f.path.startsWith(`${prefix}src/app/`),
      );
      const framework =
        typeof next === "string" && appRouter
          ? "next-app"
          : typeof tanstack === "string"
            ? "tanstack"
            : "generic";
      if (framework !== "generic" || root === ".")
        apps.push({
          root,
          name: pkg.name ?? root,
          framework,
          version:
            framework === "next-app"
              ? String(next)
              : framework === "tanstack"
                ? String(tanstack)
                : "",
          supported:
            framework === "tanstack" ||
            (framework === "next-app" && /(?:^|[^\d])16\./.test(String(next))),
        });
    } catch {
      /* Malformed metadata remains inventoried and is diagnosed during extraction. */
    }
  }
  return apps.length
    ? apps.sort((a, b) => a.root.localeCompare(b.root))
    : [{ root: ".", name: "Project", framework: "generic", version: "", supported: false }];
}

const literal = (node: ts.Node | undefined): string | undefined =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;

/** Projects syntax and framework conventions into evidence-bearing facts, never inferred execution. */
export async function extractAtlas(
  binding: Pick<CodebaseBinding, "checkout" | "inventory" | "sourceFingerprint">,
  app: AtlasApp,
  progress: (phase: string, path: string) => Promise<void>,
  signal: AbortSignal,
  syntaxCache: AtlasSyntaxCache = { files: new Map(), bytes: 0 },
): Promise<AtlasDocument> {
  syntaxCache.reparsed = 0;
  syntaxCache.reused = 0;
  const nodes: AtlasNode[] = [];
  const edges: AtlasEdge[] = [];
  const edgeIds = new Set<string>();
  const diagnostics: AtlasDocument["diagnostics"][number][] = [];
  const files: AtlasDocument["files"][number][] = [];
  const sources = new Map<string, ts.SourceFile>();
  const inventory = new Map(binding.inventory.map((f) => [f.path, f]));
  const modules = new Map<string, string>();
  const prefix = app.root === "." ? "" : `${app.root}/`;
  const source = (path: string, node?: ts.Node) => {
    const file = sources.get(path);
    const start =
      file && node ? file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 : 1;
    const end = file && node ? file.getLineAndCharacterOfPosition(node.getEnd()).line + 1 : 1;
    return {
      path,
      startLine: start,
      endLine: end,
      fingerprint: inventory.get(path)?.fingerprint ?? "",
    };
  };
  const addNode = (
    path: string,
    kind: AtlasNode["kind"],
    label: string,
    node?: ts.Node,
    identity = label,
  ) => {
    const entry: AtlasNode = {
      id: key(app.root, path, kind, identity),
      kind,
      label,
      source: source(path, node),
      pattern: null,
      parameters: [],
      layouts: [],
      boundaries: [],
      methods: [],
      roles: [],
    };
    nodes.push(entry);
    return entry;
  };
  const edge = (
    from: string,
    to: string,
    kind: AtlasEdge["kind"],
    path: string,
    node?: ts.Node,
    evidence: AtlasEdge["evidence"] = "framework-rule",
  ) => {
    if (from === to && kind !== "imports") return;
    const entry: AtlasEdge = {
      id: key(from, to, kind, path),
      from,
      to,
      kind,
      source: source(path, node),
      evidence,
      rule: `${app.framework}:${kind}:1`,
    };
    if (!edgeIds.has(entry.id)) {
      edgeIds.add(entry.id);
      edges.push(entry);
    }
  };
  let options: ts.CompilerOptions = {
    jsx: ts.JsxEmit.Preserve,
    allowJs: true,
    noEmit: true,
    noResolve: true,
    noLib: true,
    types: [],
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const configPath = ts.findConfigFile(
    NodePath.resolve(binding.checkout, app.root),
    ts.sys.fileExists,
  );
  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(
      config.config ?? {},
      ts.sys,
      NodePath.dirname(configPath),
    );
    options = {
      ...options,
      ...parsed.options,
      noEmit: true,
      noResolve: true,
      noLib: true,
      types: [],
    };
    for (const diagnostic of parsed.errors)
      diagnostics.push({
        path: slash(NodePath.relative(binding.checkout, configPath)),
        code: "compiler-config",
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " ").slice(0, 2048),
      });
  }
  const queue = binding.inventory.filter((file) => file.path.startsWith(prefix));
  const resolutionCache = ts.createModuleResolutionCache(binding.checkout, canonicalPath, options);
  const queued = new Set(queue.map((file) => file.path));
  const accounted = new Set<string>();
  let sourceBytes = 0;
  for (const file of queue) {
    accounted.add(file.path);
    if (signal.aborted) throw new Error("cancelled");
    await NodeTimersPromises.setImmediate();
    if (file.exclusion) {
      if (script.test(file.path))
        diagnostics.push({
          path: file.path,
          code: "excluded-source",
          message: `Source extraction skipped: ${file.exclusion}. Route and symbol coverage may be incomplete.`,
        });
      files.push({
        path: file.path,
        fingerprint: file.fingerprint,
        status: "excluded",
        reason: file.exclusion,
      });
      continue;
    }
    if (!script.test(file.path)) {
      files.push({
        path: file.path,
        fingerprint: file.fingerprint,
        status: /\.(json|ya?ml|css|md)$/.test(file.path) ? "metadata" : "unsupported",
        reason: null,
      });
      continue;
    }
    await progress("parsing", file.path);
    try {
      const absolute = NodePath.resolve(binding.checkout, file.path);
      const cached = syntaxCache.files.get(absolute);
      const reusable = cached?.fingerprint === file.fingerprint;
      const text = reusable ? cached.source.text : await atlasSource(binding.checkout, file.path);
      sourceBytes += Buffer.byteLength(text);
      if (sourceBytes > 8 * 1024 * 1024)
        throw new CodebaseError({
          code: "unsupported",
          message:
            "Application source exceeds the 8 MiB parser budget. Select a smaller application; the accepted atlas was preserved.",
        });
      const parsed = reusable
        ? cached.source
        : ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true);
      if (reusable) syntaxCache.reused++;
      else syntaxCache.reparsed++;
      syntaxCache.files.delete(absolute);
      syntaxCache.bytes -= cached ? Buffer.byteLength(cached.source.text) : 0;
      syntaxCache.files.set(absolute, { fingerprint: file.fingerprint, source: parsed });
      syntaxCache.bytes += Buffer.byteLength(parsed.text);
      while (syntaxCache.bytes > 8 * 1024 * 1024) {
        const oldest = syntaxCache.files.entries().next().value!;
        syntaxCache.bytes -= Buffer.byteLength(oldest[1].source.text);
        syntaxCache.files.delete(oldest[0]);
      }
      const errors =
        (parsed as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
          .parseDiagnostics ?? [];
      files.push({
        path: file.path,
        fingerprint: file.fingerprint,
        status: errors.length ? "parse-error" : "parsed",
        reason: errors.length ? ts.flattenDiagnosticMessageText(errors[0]!.messageText, " ") : null,
      });
      if (errors.length) {
        diagnostics.push({
          path: file.path,
          code: "parse-error",
          message: "Unsupported or malformed syntax; structural extraction was skipped.",
        });
        continue;
      }
      sources.set(file.path, parsed);
      modules.set(file.path, addNode(file.path, "module", file.path, undefined, "module").id);
      const discover = (node: ts.Node) => {
        const specifier =
          ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
            ? literal(node.moduleSpecifier)
            : ts.isCallExpression(node) &&
                (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                  (ts.isIdentifier(node.expression) && node.expression.text === "require"))
              ? literal(node.arguments[0])
              : undefined;
        if (specifier) {
          const resolved = ts.resolveModuleName(
            specifier,
            parsed.fileName,
            options,
            ts.sys,
            resolutionCache,
          ).resolvedModule;
          const target = resolved
            ? slash(NodePath.relative(binding.checkout, resolved.resolvedFileName))
            : "";
          const dependency = inventory.get(target);
          if (dependency && !queued.has(target)) {
            queued.add(target);
            queue.push(dependency);
          }
        }
        ts.forEachChild(node, discover);
      };
      discover(parsed);
    } catch (cause) {
      if (isCodebaseError(cause)) throw cause;
      files.push({
        path: file.path,
        fingerprint: file.fingerprint,
        status: "parse-error",
        reason: "Source could not be read safely.",
      });
    }
  }
  for (const file of binding.inventory)
    if (!accounted.has(file.path))
      files.push({
        path: file.path,
        fingerprint: file.fingerprint,
        status: file.exclusion ? "excluded" : "unsupported",
        reason:
          file.exclusion ?? "Outside the selected application and resolved dependency closure.",
      });
  await progress("resolving", app.root);
  const host = ts.createCompilerHost(options);
  const byAbsolute = new Map(
    [...sources].map(([path, sf]) => [canonicalPath(NodePath.resolve(binding.checkout, path)), sf]),
  );
  // Bind only inventoried source. Ambient library inference is outside this structural atlas.
  host.getSourceFile = (name) => byAbsolute.get(canonicalPath(name));
  host.resolveModuleNames = (names, containingFile) =>
    names.map(
      (name) =>
        ts.resolveModuleName(name, containingFile, options, ts.sys, resolutionCache).resolvedModule,
    );
  const program = ts.createProgram(
    [...sources.values()].map((sf) => sf.fileName),
    options,
    host,
  );
  const checker = program.getTypeChecker();
  const resolveSymbol = (name: string, location: ts.Node): ts.Symbol | undefined => {
    const [first, ...members] = name.split(".");
    if (!first) return undefined;
    let symbol = checker.resolveName(
      first,
      location,
      ts.SymbolFlags.Value | ts.SymbolFlags.Namespace,
      false,
    );
    const unalias = (value: ts.Symbol | undefined) =>
      value && value.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(value) : value;
    symbol = unalias(symbol);
    for (const member of members) {
      if (
        !symbol ||
        !(symbol.flags & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule))
      )
        return undefined;
      symbol = unalias(checker.getExportsOfModule(symbol).find((entry) => entry.name === member));
    }
    return symbol;
  };
  const components = new Map<ts.Node, AtlasNode>();
  const containsJsx = (node: ts.Node): boolean =>
    ts.isJsxElement(node) ||
    ts.isJsxSelfClosingElement(node) ||
    ts.isJsxFragment(node) ||
    (ts.forEachChild(node, (child) => (containsJsx(child) ? true : undefined)) ?? false);
  for (const [path, sf] of sources) {
    const declare = (node: ts.Node) => {
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isVariableDeclaration(node)) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        /^[A-Z]/.test(node.name.text) &&
        (!ts.isVariableDeclaration(node) ||
          (node.initializer &&
            (ts.isArrowFunction(node.initializer) ||
              ts.isFunctionExpression(node.initializer) ||
              (ts.isCallExpression(node.initializer) &&
                /(?:^|\.)(memo|forwardRef)$/.test(node.initializer.expression.getText(sf)))))) &&
        containsJsx(node)
      ) {
        const parents: string[] = [];
        let current = node.parent;
        while (current) {
          if ((ts.isFunctionDeclaration(current) || ts.isClassDeclaration(current)) && current.name)
            parents.unshift(current.name.text);
          current = current.parent;
        }
        const component = addNode(
          path,
          "component",
          node.name.text,
          node,
          [...parents, node.name.text].join("."),
        );
        components.set(node, component);
        edge(modules.get(path)!, component.id, "declares", path, node, "syntax");
      }
      const declaration = ts.isVariableDeclaration(node) ? node.parent.parent : node;
      const exported =
        ts.canHaveModifiers(declaration) &&
        ts
          .getModifiers(declaration)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
      if (
        exported &&
        !components.has(node) &&
        (ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isVariableDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isEnumDeclaration(node))
      ) {
        const name = node.name && ts.isIdentifier(node.name) ? node.name.text : "default";
        if (!nodes.some((entry) => entry.id === key(app.root, path, "symbol", `export:${name}`))) {
          const symbol = addNode(path, "symbol", name, node, `export:${name}`);
          nodes[nodes.length - 1] = {
            ...symbol,
            roles: [
              "export",
              ...(ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
                ? ["type-only"]
                : []),
            ],
          };
          edge(modules.get(path)!, symbol.id, "declares", path, node, "syntax");
        }
      }
      ts.forEachChild(node, declare);
    };
    declare(sf);
  }
  for (const [path, sf] of sources) {
    if (signal.aborted) throw new Error("cancelled");
    await NodeTimersPromises.setImmediate();
    const imports = new Map<string, string>();
    const resolveReference = (name: string) => {
      const result = ts.resolveModuleName(
        name,
        sf.fileName,
        options,
        ts.sys,
        resolutionCache,
      ).resolvedModule;
      return result ? slash(NodePath.relative(binding.checkout, result.resolvedFileName)) : null;
    };
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifier = literal(node.moduleSpecifier);
        if (specifier) {
          const target = resolveReference(specifier);
          if (target && modules.has(target)) {
            const clauseTypeOnly = ts.isImportDeclaration(node)
              ? !!node.importClause?.isTypeOnly
              : node.isTypeOnly;
            const named = ts.isImportDeclaration(node)
              ? node.importClause?.namedBindings
              : node.exportClause;
            const elements =
              named && (ts.isNamedImports(named) || ts.isNamedExports(named))
                ? named.elements
                : undefined;
            const hasTypes = clauseTypeOnly || elements?.some((item) => item.isTypeOnly);
            const hasValues =
              !clauseTypeOnly &&
              (!elements ||
                !elements.length ||
                elements.some((item) => !item.isTypeOnly) ||
                (ts.isImportDeclaration(node) && !!node.importClause?.name));
            if (hasTypes)
              edge(
                modules.get(path)!,
                modules.get(target)!,
                "type-dependency",
                path,
                node,
                "symbol-resolution",
              );
            if (hasValues)
              edge(
                modules.get(path)!,
                modules.get(target)!,
                ts.isExportDeclaration(node) ? "re-exports" : "imports",
                path,
                node,
                "symbol-resolution",
              );
            if (ts.isImportDeclaration(node)) {
              if (node.importClause?.name) imports.set(node.importClause.name.text, target);
              const bindings = node.importClause?.namedBindings;
              if (bindings && ts.isNamedImports(bindings))
                for (const item of bindings.elements)
                  if (!item.isTypeOnly) imports.set(item.name.text, target);
            }
          } else if (specifier.startsWith(".") || specifier.startsWith("@/"))
            diagnostics.push({
              path,
              code: "unresolved-import",
              message: `Cannot resolve source target: ${specifier}`,
            });
        }
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        const specifier = literal(node.arguments[0]);
        const target = specifier ? resolveReference(specifier) : null;
        if (target && modules.has(target))
          edge(
            modules.get(path)!,
            modules.get(target)!,
            "imports",
            path,
            node,
            "symbol-resolution",
          );
        else
          diagnostics.push({
            path,
            code: "dynamic-import",
            message: specifier
              ? `Unresolved dynamic module: ${specifier}`
              : "Computed module target remains unknown.",
          });
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const name = node.tagName.getText(sf);
        if (/^[A-Z]/.test(name)) {
          const symbol = resolveSymbol(name, node);
          const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
          const target = declaration ? components.get(declaration) : undefined;
          const targetPath = imports.get(name);
          const targetId =
            target?.id ??
            (targetPath
              ? nodes.find(
                  (n) => n.kind === "component" && n.source.path === targetPath && n.label === name,
                )?.id
              : undefined);
          if (targetId)
            edge(modules.get(path)!, targetId, "jsx-uses", path, node, "symbol-resolution");
          else
            diagnostics.push({
              path,
              code: "unresolved-component",
              message: `JSX target ${name} could not be linked to an inventoried declaration.`,
            });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (/(?:next\.config|vite\.config|proxy\.|middleware\.)/.test(path))
      diagnostics.push({
        path,
        code: "request-configuration",
        message:
          "Executable configuration/request gates are inventoried but not evaluated; verify preview paths and routing coverage.",
      });
  }
  if (app.framework === "next-app") {
    const appPrefix = [...sources.keys()].some((p) => p.startsWith(`${prefix}app/`))
      ? `${prefix}app/`
      : `${prefix}src/app/`;
    const roles = new Map<string, AtlasNode>();
    for (const [path, sf] of sources) {
      if (!path.startsWith(appPrefix)) continue;
      const relative = path.slice(appPrefix.length);
      if (relative.split("/").some((p) => p.startsWith("_"))) continue;
      const role = NodePath.posix.basename(relative).replace(script, "");
      const special = [
        "page",
        "route",
        "layout",
        "template",
        "loading",
        "error",
        "global-error",
        "not-found",
        "default",
      ];
      if (!special.includes(role)) continue;
      const directory = NodePath.posix.dirname(relative);
      const segments = directory === "." ? [] : directory.split("/");
      const parameters: AtlasNode["parameters"][number][] = [];
      const urls: string[] = [];
      for (let segment of segments) {
        if (segment.startsWith("@") || /^\([^.)][^)]*\)$/.test(segment)) continue;
        if (segment.startsWith("(")) {
          diagnostics.push({
            path,
            code: "navigation-context",
            message:
              "Intercepted route requires navigation context; only direct navigation is captured in this release.",
          });
          if (segment.startsWith("(...)")) urls.splice(0);
          else {
            const levels = segment.match(/\(\.\.\)/g)?.length ?? 0;
            urls.splice(Math.max(0, urls.length - levels));
          }
          segment = segment.replace(/^(?:\(\.\.\.\)|\(\.\.\)|\(\.\))+/, "");
        }
        const dynamic =
          /^\[\[\.\.\.(.+)\]\]$/.exec(segment) ??
          /^\[\.\.\.(.+)\]$/.exec(segment) ??
          /^\[(.+)\]$/.exec(segment);
        if (dynamic)
          parameters.push({
            name: dynamic[1]!,
            kind: segment.startsWith("[[")
              ? "optional-catch-all"
              : segment.startsWith("[...")
                ? "catch-all"
                : "single",
          });
        urls.push(segment);
      }
      const kind =
        role === "page"
          ? "route"
          : role === "route"
            ? "endpoint"
            : ["layout", "template"].includes(role)
              ? "layout"
              : "boundary";
      const entry = addNode(
        path,
        kind,
        role === "page" || role === "route" ? `/${urls.join("/")}` : `${role} · ${directory}`,
        undefined,
        role,
      );
      const mutable = {
        ...entry,
        pattern: kind === "route" || kind === "endpoint" ? `/${urls.join("/")}` : null,
        parameters,
        roles: [role, ...segments.filter((s) => s.startsWith("@") || /^\(\.{1,3}\)/.test(s))],
      };
      if (kind === "endpoint")
        mutable.methods = sf.statements.flatMap((s) =>
          ts.isFunctionDeclaration(s) &&
          s.name &&
          ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(s.name.text) &&
          s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
            ? [s.name.text]
            : ts.isVariableStatement(s) &&
                s.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
              ? s.declarationList.declarations.flatMap((d) =>
                  ts.isIdentifier(d.name) &&
                  /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(d.name.text)
                    ? [d.name.text]
                    : [],
                )
              : [],
        );
      nodes[nodes.length - 1] = mutable;
      roles.set(`${directory}:${role}`, mutable);
      edge(mutable.id, modules.get(path)!, "route-entry", path);
    }
    for (const entry of roles.values()) {
      if (entry.kind !== "route") continue;
      const relative = NodePath.posix.relative(appPrefix, entry.source.path);
      const directory = NodePath.posix.dirname(relative);
      const parts = directory === "." ? [] : directory.split("/");
      const layouts: string[] = [],
        boundaries: string[] = [];
      for (let i = 0; i <= parts.length; i++) {
        const parent = i === 0 ? "." : parts.slice(0, i).join("/");
        for (const role of [
          "layout",
          "template",
          "loading",
          "error",
          "global-error",
          "not-found",
        ]) {
          const wrapper = roles.get(`${parent}:${role}`);
          if (!wrapper) continue;
          (wrapper.kind === "layout" ? layouts : boundaries).push(wrapper.id);
          edge(
            wrapper.id,
            entry.id,
            wrapper.kind === "layout" ? "layout-wraps" : "boundary-applies",
            wrapper.source.path,
          );
        }
      }
      nodes[nodes.indexOf(entry)] = { ...entry, layouts, boundaries };
      if (entry.roles.some((role) => role.startsWith("@")) && layouts.length)
        edge(layouts.at(-1)!, entry.id, "slot", entry.source.path);
      if (entry.roles.some((role) => /^\(\.{1,3}\)/.test(role))) {
        const targets = [...roles.values()].filter(
          (candidate) =>
            candidate.kind === "route" &&
            candidate.pattern === entry.pattern &&
            !candidate.roles.some((role) => /^\(\.{1,3}\)/.test(role)),
        );
        if (targets.length === 1) edge(entry.id, targets[0]!.id, "intercepts", entry.source.path);
        else
          diagnostics.push({
            path: entry.source.path,
            code: "interception-target",
            message:
              "The interception target is ambiguous or absent; runtime navigation context remains required.",
          });
      }
    }
  } else if (app.framework === "tanstack") {
    const composition = (
      entry: AtlasNode,
      call: ts.CallExpression,
      sf: ts.SourceFile,
      path: string,
    ) => {
      const invocation =
        ts.isCallExpression(call.parent) && call.parent.expression === call ? call.parent : call;
      const options = invocation.arguments[0];
      if (!options || !ts.isObjectLiteralExpression(options)) {
        diagnostics.push({
          path,
          code: "computed-route-options",
          message: "Route composition is computed; component and boundary coverage is partial.",
        });
        return;
      }
      const boundaries: string[] = [];
      for (const property of options.properties) {
        if (ts.isSpreadAssignment(property)) {
          diagnostics.push({
            path,
            code: "computed-route-options",
            message:
              "Spread route options may add components or boundaries that cannot be established statically.",
          });
          continue;
        }
        if (!ts.isPropertyAssignment(property)) continue;
        const role = property.name.getText(sf).replace(/["']/g, "");
        if (
          !["component", "pendingComponent", "errorComponent", "notFoundComponent"].includes(role)
        )
          continue;
        const symbol =
          ts.isIdentifier(property.initializer) ||
          ts.isPropertyAccessExpression(property.initializer)
            ? resolveSymbol(property.initializer.getText(sf), property)
            : undefined;
        const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
        let target = declaration ? components.get(declaration) : undefined;
        if (
          !target &&
          (ts.isArrowFunction(property.initializer) ||
            ts.isFunctionExpression(property.initializer)) &&
          containsJsx(property.initializer)
        )
          target = addNode(
            path,
            "component",
            `${entry.label} ${role}`,
            property.initializer,
            `${entry.id}:${role}:inline`,
          );
        if (role === "component") {
          if (target) edge(entry.id, target.id, "route-entry", path, property, "symbol-resolution");
        } else {
          const boundary = addNode(path, "boundary", role, property, `${entry.id}:${role}`);
          nodes[nodes.indexOf(boundary)] = { ...boundary, roles: [role] };
          boundaries.push(boundary.id);
          edge(boundary.id, entry.id, "boundary-applies", path, property);
          if (target)
            edge(boundary.id, target.id, "route-entry", path, property, "symbol-resolution");
        }
        if (!target)
          diagnostics.push({
            path,
            code: "unresolved-route-component",
            message: `Route option ${role} could not be linked to an inventoried component declaration.`,
          });
      }
      const index = nodes.findIndex((node) => node.id === entry.id);
      nodes[index] = { ...nodes[index]!, boundaries };
    };
    let routePrefix = `${prefix}src/routes/`;
    if (![...sources.keys()].some((path) => path.startsWith(routePrefix)))
      routePrefix = `${prefix}routes/`;
    for (const [path, sf] of sources)
      if (path.startsWith(prefix) && /(?:vite|router)\.config\./.test(path)) {
        const configuration = (node: ts.Node) => {
          if (
            ts.isPropertyAssignment(node) &&
            node.name.getText(sf).replace(/["']/g, "") === "routesDirectory"
          ) {
            const directory = literal(node.initializer);
            if (directory)
              routePrefix =
                NodePath.posix.normalize(`${prefix}${directory}`).replace(/\/$/, "") + "/";
            else
              diagnostics.push({
                path,
                code: "computed-route-directory",
                message:
                  "The route directory is computed. Default-directory route facts are partial.",
              });
          }
          ts.forEachChild(node, configuration);
        };
        configuration(sf);
      }
    for (const [path, sf] of sources) {
      if (!path.startsWith(routePrefix) || /(^|\/)\-|\.(test|spec)\.[cm]?[jt]sx?$/.test(path))
        continue;
      const factories = new Map<string, string>();
      const namespaces = new Set<string>();
      for (const statement of sf.statements)
        if (
          ts.isImportDeclaration(statement) &&
          literal(statement.moduleSpecifier) === "@tanstack/react-router" &&
          !statement.importClause?.isTypeOnly
        ) {
          const bindings = statement.importClause?.namedBindings;
          if (bindings && ts.isNamedImports(bindings))
            for (const element of bindings.elements)
              if (!element.isTypeOnly)
                factories.set(element.name.text, element.propertyName?.text ?? element.name.text);
          if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
        }
      const visit = (node: ts.Node) => {
        const factory = ts.isCallExpression(node)
          ? ts.isIdentifier(node.expression)
            ? factories.get(node.expression.text)
            : ts.isPropertyAccessExpression(node.expression) &&
                ts.isIdentifier(node.expression.expression) &&
                namespaces.has(node.expression.expression.text)
              ? node.expression.name.text
              : undefined
          : undefined;
        if (
          ts.isCallExpression(node) &&
          factory &&
          ["createRootRoute", "createRootRouteWithContext"].includes(factory)
        ) {
          const entry = addNode(path, "layout", "Root layout", node, "root-layout");
          nodes[nodes.length - 1] = { ...entry, roles: ["/__root"] };
          edge(entry.id, modules.get(path)!, "route-entry", path, node);
          composition(entry, node, sf, path);
        }
        if (
          ts.isCallExpression(node) &&
          factory &&
          ["createFileRoute", "createLazyFileRoute"].includes(factory)
        ) {
          const route = literal(node.arguments[0]);
          if (route) {
            const segments = route
              .split("/")
              .filter((s) => s && !s.startsWith("_") && !/^\(.+\)$/.test(s));
            const pattern = "/" + segments.map((s) => s.replace(/_$/, "")).join("/");
            const pathless = route.split("/").at(-1)?.startsWith("_");
            const entry = addNode(
              path,
              pathless ? "layout" : "route",
              pathless ? `Layout ${route}` : pattern,
              node,
              route,
            );
            nodes[nodes.length - 1] = {
              ...entry,
              pattern: pathless ? null : pattern,
              parameters: segments
                .filter((s) => s.startsWith("$"))
                .map((s) => ({
                  name: s.slice(1) || "_splat",
                  kind: s === "$" ? "catch-all" : "single",
                })),
              roles: [route],
            };
            edge(entry.id, modules.get(path)!, "route-entry", path, node);
            composition(entry, node, sf, path);
          } else
            diagnostics.push({
              path,
              code: "computed-route",
              message: "Computed file-route declaration cannot establish a route pattern.",
            });
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    const routes = nodes.filter((n) => n.kind === "route" || n.kind === "layout");
    for (const route of routes) {
      const identity = route.roles[0]!;
      const parents = routes
        .filter(
          (r) => r !== route && (r.roles[0] === "/__root" || identity.startsWith(`${r.roles[0]}/`)),
        )
        .sort((a, b) =>
          a.roles[0] === "/__root"
            ? -1
            : b.roles[0] === "/__root"
              ? 1
              : a.roles[0]!.length - b.roles[0]!.length,
        );
      nodes[nodes.indexOf(route)] = {
        ...route,
        layouts: parents.map((r) => r.id),
        boundaries: [
          ...new Set([...parents.flatMap((parent) => parent.boundaries), ...route.boundaries]),
        ],
      };
      for (const parent of parents) edge(parent.id, route.id, "layout-wraps", parent.source.path);
      for (const boundary of parents.flatMap((parent) => parent.boundaries)) {
        const node = nodes.find((entry) => entry.id === boundary)!;
        edge(boundary, route.id, "boundary-applies", node.source.path);
      }
    }
    const declaredPatterns = new Set(
      routes
        .filter((route) => route.kind === "route")
        .map((route) => route.pattern?.replace(/\/$/, "") || "/"),
    );
    for (const [path, sf] of sources)
      if (path.startsWith(prefix) && /routeTree\.gen\./.test(path)) {
        const observed = new Set<string>();
        const visit = (node: ts.Node) => {
          if (ts.isInterfaceDeclaration(node) && node.name.text === "FileRoutesByFullPath")
            for (const member of node.members)
              if (ts.isPropertySignature(member) && ts.isStringLiteral(member.name))
                observed.add(member.name.text.replace(/\/$/, "") || "/");
          ts.forEachChild(node, visit);
        };
        visit(sf);
        if (
          observed.size &&
          (observed.size !== declaredPatterns.size ||
            [...observed].some((pattern) => !declaredPatterns.has(pattern)))
        )
          diagnostics.push({
            path,
            code: "generated-route-mismatch",
            message:
              "Generated route patterns disagree with current source declarations; source facts remain authoritative.",
          });
      }
  }
  if (!app.supported)
    diagnostics.push({
      path: app.root,
      code: "partial-framework",
      message:
        "Generic source facts are available; complete route coverage is not supported for this framework/version.",
    });
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id));
  files.sort((a, b) => a.path.localeCompare(b.path));
  diagnostics.sort((a, b) =>
    `${a.path}:${a.code}:${a.message}`.localeCompare(`${b.path}:${b.code}:${b.message}`),
  );
  return {
    version: 2,
    extractor: ATLAS_EXTRACTOR_VERSION,
    app,
    sourceFingerprint: binding.sourceFingerprint,
    nodes,
    edges,
    files,
    diagnostics,
    coverage: {
      totalFiles: files.length,
      parsedFiles: files.filter((f) => f.status === "parsed").length,
      unresolved: diagnostics.length,
      routes: nodes.filter((n) => n.kind === "route").length,
      endpoints: nodes.filter((n) => n.kind === "endpoint").length,
      partial:
        !app.supported || diagnostics.length > 0 || files.some((f) => f.status === "parse-error"),
    },
  };
}

const WorkerMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("progress"), phase: Schema.String, path: Schema.String }),
  Schema.Struct({ type: Schema.Literal("result"), document: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
const decodeWorkerMessage = Schema.decodeUnknownSync(WorkerMessage);

/** Compiler work runs outside the server event loop and cancellation terminates only its owned worker. */
export function makeAtlasExtractor() {
  let worker: NodeWorkerThreads.Worker | undefined;
  const close = async () => {
    const owned = worker;
    worker = undefined;
    await owned?.terminate();
  };
  const extract = (
    binding: CodebaseBinding,
    app: AtlasApp,
    progress: (phase: string, path: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<AtlasDocument> => {
    return new Promise((accept, reject) => {
      worker ??= new NodeWorkerThreads.Worker(
        new URL(
          import.meta.url.endsWith(".ts") ? "./AtlasWorker.ts" : "./codebase/AtlasWorker.mjs",
          import.meta.url,
        ),
      );
      const owned = worker;
      owned.ref();
      let settled = false;
      const finish = (error?: Error, document?: AtlasDocument) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        owned.off("message", messageReceived);
        owned.off("error", failed);
        owned.off("exit", exited);
        if (error) void close();
        else owned.unref();
        if (error) reject(error);
        else if (document) accept(document);
      };
      const abort = () => finish(new Error("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      const messageReceived = (value: unknown) => {
        try {
          // Node's --watch runner reports worker imports over this same channel.
          if (typeof value === "object" && value !== null && !("type" in value)) return;
          const message = decodeWorkerMessage(value);
          if (message.type === "progress")
            void progress(message.phase, message.path)
              .then(() => {
                if (!settled) owned.postMessage({ type: "continue" });
              })
              .catch((cause: unknown) => finish(new Error(String(cause))));
          else if (message.type === "error") finish(new Error(message.message));
          else finish(undefined, decodeDocument(message.document));
        } catch (cause) {
          finish(new Error(String(cause)));
        }
      };
      const failed = (error: Error) => finish(error);
      const exited = () => {
        if (!settled)
          finish(new Error("The source indexing worker exited before producing an atlas."));
      };
      owned.on("message", messageReceived);
      owned.on("error", failed);
      owned.on("exit", exited);
      if (signal.aborted) {
        abort();
        return;
      }
      owned.postMessage({
        type: "extract",
        binding: {
          checkout: binding.checkout,
          sourceFingerprint: binding.sourceFingerprint,
          inventory: binding.inventory.map((file) => ({ ...file, text: null })),
        },
        app,
      });
    });
  };
  return { extract, close };
}
