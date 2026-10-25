import { expect, it } from "vite-plus/test";
import { createSourceFingerprint } from "./CodebaseFingerprint.ts";

const fingerprint = (...chunks: string[]) => {
  const hash = createSourceFingerprint();
  for (const chunk of chunks) hash.update(Buffer.from(chunk));
  return hash.digest();
};
it("normalizes checkout line endings across stream boundaries", () => {
  expect(fingerprint("first\r", "\nsecond\r\n")).toBe(fingerprint("first\nsecond\n"));
  expect(fingerprint("first\r", "second\r")).toBe(fingerprint("first\rsecond\r"));
  expect(fingerprint("first\r", "second")).not.toBe(fingerprint("firstsecond"));
});
it("keeps binary files byte-exact even when the zero byte appears in a later chunk", () => {
  expect(fingerprint("first\r\n", "\0")).not.toBe(fingerprint("first\n", "\0"));
  expect(fingerprint("first\r\n", "\0")).toBe(fingerprint("first\r\n\0"));
});
