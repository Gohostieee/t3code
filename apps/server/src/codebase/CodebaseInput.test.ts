import { expect, it } from "vite-plus/test";
import { CODEBASE_LIMITS } from "@t3tools/contracts";
import { buildCodebaseInput, isExcludedCodebaseSource } from "./CodebaseInput.ts";

it("supplies a late-file detail anchor with original line numbers within the same budget", () => {
  const text = Array.from(
    { length: 2000 },
    (_, index) => `export const value${index + 1} = ${index + 1};`,
  ).join("\n");
  const result = buildCodebaseInput({
    scopeId: "detail",
    previousNodes: [],
    inventory: [{ path: "large.ts", text }],
    focus: {
      id: "late",
      kind: "function",
      name: "Late function",
      responsibility: "Computes a value",
      explanation: "A late function",
      technologies: [],
      expandable: true,
      sources: [{ path: "large.ts", startLine: 1800, endLine: 1810 }],
    },
  });
  expect(result.prompt).toContain("1800: export const value1800 = 1800;");
  expect(result.prompt.length).toBeLessThanOrEqual(CODEBASE_LIMITS.promptCharacters);
  expect(result.supplied[0]).toMatchObject({ startLine: 1792, truncated: true });
  expect(result.supplied[0]!.endLine).toBeGreaterThanOrEqual(1810);
});

it("counts every file excluded by the final prompt budget and supplies schema definitions", () => {
  const inventory = Array.from({ length: 100 }, (_, index) => ({
    path: `src/file${index}.ts`,
    text: "export const value = 1;\n".repeat(500),
  }));
  const result = buildCodebaseInput({
    scopeId: "overview",
    focus: null,
    previousNodes: [],
    inventory,
  });
  expect(result.prompt.length).toBeLessThanOrEqual(CODEBASE_LIMITS.promptCharacters);
  expect(result.omittedFiles).toBe(100 - result.supplied.length);
  expect(result.omittedFiles).toBeGreaterThan(0);
  const schemaLine = result.prompt.split("\n").find((line) => line.startsWith("Schema: "))!;
  const schema = JSON.parse(schemaLine.slice(8));
  expect(Object.keys(schema.$defs).length).toBeGreaterThan(0);
  expect(JSON.stringify(schema)).toContain("startLine");
  expect(JSON.stringify(schema)).toContain("^[a-zA-Z0-9_-]+$");
  for (const path of [
    "target/debug/test",
    ".next/cache/file",
    "vendor/module",
    "apps/web/node_modules/file",
  ])
    expect(isExcludedCodebaseSource(path)).toBe(true);
});

it("keeps long source paths within budget and supplies the parent boundary on the first detail pass", () => {
  const result = buildCodebaseInput({
    scopeId: "detail",
    parentScopeId: "overview",
    parentNodes: [],
    focus: null,
    previousNodes: [],
    inventory: Array.from({ length: 100 }, (_, index) => ({
      path: `${("a".repeat(90) + "/").repeat(10)}file${index}.ts`,
      text: ("x".repeat(126) + "\n").repeat(1000),
    })),
  });
  expect(result.prompt.length).toBeLessThanOrEqual(CODEBASE_LIMITS.promptCharacters);
  expect(result.prompt).toContain('"scopeId":"overview"');
  expect(result.supplied.length).toBeGreaterThan(0);
});
