import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { CodebaseGraph, CodebaseManifest } from "./codebase.ts";

describe("portable codebase documents", () => {
  it("rejects relationships without endpoints and unsafe source references", () => {
    const graph = {
      title: "Application",
      summary: "An application with a web client.",
      nodes: [
        {
          id: "web",
          kind: "client",
          name: "Web",
          responsibility: "User interface",
          explanation: "Renders the application.",
          technologies: ["React"],
          sources: [{ path: "src/app.tsx", startLine: 1, endLine: 3 }],
          expandable: true,
        },
      ],
      edges: [],
      omissions: [],
    };
    expect(Schema.is(CodebaseGraph)(graph)).toBe(true);
    expect(
      Schema.is(CodebaseGraph)({
        ...graph,
        edges: [
          {
            id: "request",
            from: "web",
            to: "missing",
            kind: "requests",
            label: "API",
            explanation: "Requests data.",
            evidence: "inferred",
            sources: [],
          },
        ],
      }),
    ).toBe(false);
    expect(Schema.is(CodebaseGraph)({ ...graph, nodes: [graph.nodes[0], graph.nodes[0]] })).toBe(
      false,
    );
    for (const path of [
      "../secret",
      "/etc/passwd",
      "C:/private",
      "src/../../secret",
      "src\\app.tsx",
    ]) {
      expect(
        Schema.is(CodebaseGraph)({
          ...graph,
          nodes: [{ ...graph.nodes[0], sources: [{ path, startLine: 1, endLine: 1 }] }],
        }),
      ).toBe(false);
    }
  });

  it("opens portable preferences without environment-specific account identities", () => {
    const manifest = {
      version: 1,
      projectPath: ".",
      rootScopeId: "overview",
      analyzers: {
        default: {
          driverKind: "codex",
          model: "configured-model",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      },
    };
    expect(Schema.is(CodebaseManifest)(manifest)).toBe(true);
    expect(Schema.is(CodebaseManifest)({ ...manifest, version: 2 })).toBe(false);
  });
});
