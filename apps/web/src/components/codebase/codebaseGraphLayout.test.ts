import type { CodebaseEdge, CodebaseNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { codebaseGraphLayout } from "./codebaseGraphLayout";

const node = (id: string): CodebaseNode => ({
  id,
  name: id,
  kind: "module",
  responsibility: "Describe the system.",
  explanation: "Details about the system.",
  technologies: [],
  sources: [],
  expandable: false,
});
const edge = (from: string, to: string): CodebaseEdge => ({
  id: `${from}-${to}`,
  from,
  to,
  kind: "calls",
  label: "Calls",
  explanation: "The systems communicate.",
  evidence: "inferred",
  sources: [],
});
const nodes = [node("entry"), node("service"), node("storage")];
const edges = [edge("entry", "service"), edge("service", "storage")];

describe("codebase graph layout", () => {
  it("uses the full available canvas rather than a fixed-size graph", () => {
    const viewport = { width: 1600, height: 900 };
    const layout = codebaseGraphLayout(nodes, edges, viewport);

    expect(layout.width).toBe(viewport.width);
    expect(layout.height).toBe(viewport.height);
    expect(layout.nodeWidth).toBeGreaterThan(236);
    const rightmost = Math.max(...layout.nodes.map((item) => item.x + layout.nodeWidth));
    expect(viewport.width - rightmost).toBeLessThanOrEqual(40);
  });

  it("expands cards and spreads rows when the viewport grows", () => {
    const crowded = [...nodes, node("second-service")];
    const connections = [
      ...edges,
      edge("entry", "second-service"),
      edge("second-service", "storage"),
    ];
    const small = codebaseGraphLayout(crowded, connections, { width: 1000, height: 600 });
    const large = codebaseGraphLayout(crowded, connections, { width: 1800, height: 1000 });

    expect(large.nodeWidth).toBeGreaterThan(small.nodeWidth);
    const smallRow = small.nodes.find((item) => item.node.id === "second-service")!;
    const largeRow = large.nodes.find((item) => item.node.id === "second-service")!;
    expect(largeRow.y).toBeGreaterThan(smallRow.y);
    expect(largeRow.x).toBeGreaterThan(smallRow.x);
  });

  it("keeps dense maps readable and scrollable on narrow canvases", () => {
    const crowded = Array.from({ length: 12 }, (_, index) => node(`service-${index}`));
    const layout = codebaseGraphLayout(crowded, [], { width: 320, height: 480 });

    expect(layout.nodeWidth).toBeGreaterThanOrEqual(236);
    expect(layout.width).toBeGreaterThanOrEqual(320);
    expect(layout.height).toBeGreaterThan(480);
    for (const [index, item] of layout.nodes.entries()) {
      expect(item.x).toBeGreaterThanOrEqual(24);
      expect(item.x + layout.nodeWidth).toBeLessThanOrEqual(layout.width - 24);
      expect(item.y + layout.nodeHeight).toBeLessThanOrEqual(layout.height - 24);
      if (index > 0) {
        const previous = layout.nodes[index - 1]!;
        expect(item.y - previous.y - layout.nodeHeight).toBeGreaterThanOrEqual(24);
      }
    }
  });

  it("handles an empty map without invalid dimensions", () => {
    const layout = codebaseGraphLayout([], [], { width: 1200, height: 800 });

    expect(layout.nodes).toEqual([]);
    expect(layout.width).toBe(1200);
    expect(layout.height).toBe(800);
    expect(Number.isFinite(layout.nodeWidth)).toBe(true);
  });
});
