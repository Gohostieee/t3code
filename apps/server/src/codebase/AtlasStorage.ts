// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics nodeBuiltinImport:off
import * as Schema from "effect/Schema";
import { AtlasDocument, AtlasDocumentation, CodebaseError } from "@t3tools/contracts";
import { atlasHash } from "./AtlasExtractor.ts";

const Manifest = Schema.Struct({
  version: Schema.Literal(2),
  revision: Schema.String,
  chunks: Schema.Array(Schema.String),
});
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest));
const decodeChunk = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String));
const decodeDocument = Schema.decodeUnknownSync(Schema.fromJsonString(AtlasDocument));
const decodeDocumentation = Schema.decodeUnknownSync(Schema.fromJsonString(AtlasDocumentation));
const encode = (value: unknown) => `${encodeJson(value)}\n`;
const acceptedCache = new Map<
  string,
  { manifest: string; accepted: { revision: string; document: AtlasDocument } }
>();
export const emptyAtlasDocumentation = (): AtlasDocumentation => ({
  version: 1,
  features: [],
  scenarios: [],
});
export const atlasDirectory = (checkout: string, appRoot: string) =>
  NodePath.join(checkout, ".t3-codebase", "atlas", atlasHash(appRoot).slice(0, 24));

export async function safeAtlasDirectory(checkout: string, directory: string) {
  const relative = NodePath.relative(checkout, directory);
  if (relative.startsWith("..") || NodePath.isAbsolute(relative))
    throw new CodebaseError({
      code: "invalid",
      message: "Atlas location is outside the selected checkout.",
    });
  let current = checkout;
  for (const part of relative.split(NodePath.sep)) {
    current = NodePath.join(current, part);
    await NodeFSP.mkdir(current).catch((cause: unknown) => {
      if (
        !(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST")
      )
        throw cause;
    });
    if (!(await NodeFSP.lstat(current)).isDirectory())
      throw new CodebaseError({
        code: "invalid",
        message: "Atlas directories must be regular directories.",
      });
  }
}

export async function atlasReadText(path: string) {
  try {
    const stat = await NodeFSP.lstat(path);
    if (!stat.isFile() || stat.size > 512 * 1024)
      throw new CodebaseError({
        code: "invalid",
        message: "Atlas document is not a bounded regular file.",
      });
    return (await NodeFSP.readFile(path, "utf8")).replaceAll("\r\n", "\n");
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
      return null;
    throw cause;
  }
}

export async function atlasAtomicWrite(path: string, text: string) {
  if (Buffer.byteLength(text) > 512 * 1024)
    throw new CodebaseError({ code: "invalid", message: "Atlas document exceeds 512 KiB." });
  const temporary = `${path}.${process.pid}.${NodeCrypto.randomBytes(16).toString("hex")}.tmp`;
  const handle = await NodeFSP.open(temporary, "wx");
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await NodeFSP.rename(temporary, path);
  } finally {
    await NodeFSP.unlink(temporary).catch(() => undefined);
  }
}

export async function readAtlas(checkout: string, appRoot: string, useCache = false) {
  const directory = atlasDirectory(checkout, appRoot);
  const text = await atlasReadText(NodePath.join(directory, "manifest.json"));
  if (!text) return null;
  const cached = acceptedCache.get(directory);
  if (useCache && cached?.manifest === text) return cached.accepted;
  const manifest = decodeManifest(text);
  if (
    manifest.chunks.length > 512 ||
    manifest.chunks.some((name) => !/^[a-f0-9]{64}\.json$/.test(name))
  )
    throw new CodebaseError({ code: "invalid", message: "Invalid atlas chunk references." });
  const chunks: string[] = [];
  for (const chunk of manifest.chunks) {
    const text = await atlasReadText(NodePath.join(directory, chunk));
    if (!text || atlasHash(text) !== chunk.slice(0, -5))
      throw new CodebaseError({
        code: "invalid",
        message:
          "Atlas content is missing or changed. Restore it from Git, or move this application's atlas directory aside before indexing again. Existing files were preserved.",
      });
    chunks.push(decodeChunk(text));
  }
  const combined = chunks.join("");
  if (atlasHash(combined) !== manifest.revision)
    throw new CodebaseError({
      code: "invalid",
      message: "Atlas revision does not match its content.",
    });
  const accepted = {
    revision: manifest.revision,
    document: decodeDocument(combined),
  };
  acceptedCache.delete(directory);
  acceptedCache.set(directory, { manifest: text, accepted });
  if (acceptedCache.size > 2) acceptedCache.delete(acceptedCache.keys().next().value!);
  return accepted;
}

/** Immutable chunks are written before the single accepted manifest pointer is replaced. */
export async function writeAtlas(
  checkout: string,
  appRoot: string,
  document: AtlasDocument,
  beforeAccept?: () => Promise<void>,
) {
  const directory = atlasDirectory(checkout, appRoot);
  await safeAtlasDirectory(checkout, directory);
  const text = encode(document);
  if (Buffer.byteLength(text) > 32 * 1024 * 1024)
    throw new CodebaseError({
      code: "unsupported",
      message: "Atlas exceeds 32 MiB. Choose a smaller project root.",
    });
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += 120000) {
    const content = encode(text.slice(offset, offset + 120000));
    const name = `${atlasHash(content)}.json`;
    await atlasAtomicWrite(NodePath.join(directory, name), content);
    chunks.push(name);
  }
  const revision = atlasHash(text);
  await beforeAccept?.();
  await atlasAtomicWrite(
    NodePath.join(directory, "manifest.json"),
    encode({ version: 2, revision, chunks }),
  );
  return revision;
}

export async function readAtlasDocumentation(checkout: string, appRoot: string) {
  const text = await atlasReadText(
    NodePath.join(atlasDirectory(checkout, appRoot), "documentation.json"),
  );
  return {
    revision: text ? atlasHash(text) : null,
    documentation: text ? decodeDocumentation(text) : emptyAtlasDocumentation(),
  };
}

export async function writeAtlasDocumentation(
  checkout: string,
  appRoot: string,
  documentation: AtlasDocumentation,
) {
  const directory = atlasDirectory(checkout, appRoot);
  await safeAtlasDirectory(checkout, directory);
  await atlasAtomicWrite(NodePath.join(directory, "documentation.json"), encode(documentation));
}
