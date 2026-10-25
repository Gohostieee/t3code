import * as NodeCrypto from "node:crypto";

/** Git checkouts may use LF or CRLF; binary files retain byte-exact fingerprints. */
export function createSourceFingerprint() {
  const raw = NodeCrypto.createHash("sha256");
  const normalized = NodeCrypto.createHash("sha256");
  let binary = false;
  let pendingCR = false;
  return {
    update(chunk: Buffer) {
      if (chunk.length === 0) return;
      raw.update(chunk);
      binary ||= chunk.includes(0);
      if (pendingCR && chunk[0] !== 10) normalized.update("\r");
      pendingCR = false;
      let start = 0;
      for (let index = chunk.indexOf(13); index !== -1; index = chunk.indexOf(13, index + 1)) {
        if (index === chunk.length - 1) {
          normalized.update(chunk.subarray(start, index));
          pendingCR = true;
          start = chunk.length;
          break;
        }
        if (chunk[index + 1] === 10) {
          normalized.update(chunk.subarray(start, index));
          start = index + 1;
        }
      }
      normalized.update(chunk.subarray(start));
    },
    digest() {
      if (pendingCR) normalized.update("\r");
      return (binary ? raw : normalized).digest("hex");
    },
  };
}
