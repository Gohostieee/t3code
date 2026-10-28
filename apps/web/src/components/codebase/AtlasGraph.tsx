import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AtlasNode, AtlasEdge } from "@t3tools/contracts";
import { codebaseGraphLayout } from "./codebaseGraphLayout";
import { Button } from "../ui/button";

export function AtlasGraph({
  nodes,
  edges,
  onInspect,
  onExplore,
  onSource,
}: {
  nodes: readonly AtlasNode[];
  edges: readonly AtlasEdge[];
  onInspect: (node: AtlasNode) => void;
  onExplore: (node: AtlasNode) => void;
  onSource: (node: AtlasNode) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 960, height: 560 });
  const marker = useId();
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setSize({
          width: entry.contentRect.width,
          height: Math.max(560, entry.contentRect.height),
        });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const layout = useMemo(() => codebaseGraphLayout(nodes, edges, size), [nodes, edges, size]);
  const positions = new Map(layout.nodes.map((n) => [n.node.id, n]));
  return (
    <div
      ref={viewport}
      className="min-h-[560px] overflow-auto rounded-lg border bg-muted/10"
      aria-label="Source relationship map"
    >
      <div className="relative" style={{ width: layout.width, height: layout.height }}>
        <svg
          width={layout.width}
          height={layout.height}
          className="absolute inset-0 text-muted-foreground/50"
          aria-label="Source-derived connections"
        >
          <defs>
            <marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8" fill="currentColor" />
            </marker>
          </defs>
          {edges.map((edge) => {
            const from = positions.get(edge.from),
              to = positions.get(edge.to);
            if (!from || !to) return null;
            const x = from.x + layout.nodeWidth,
              y = from.y + 70,
              endX = to.x,
              endY = to.y + 70;
            return (
              <g key={edge.id}>
                <path
                  d={`M${x},${y} C${x + 35},${y} ${endX - 35},${endY} ${endX},${endY}`}
                  fill="none"
                  stroke="currentColor"
                  markerEnd={`url(#${marker})`}
                />
                <title>{`${from.node.label} — ${edge.kind} → ${to.node.label}; ${edge.evidence}`}</title>
              </g>
            );
          })}
        </svg>
        {layout.nodes.map(({ node, x, y }) => (
          <article
            key={node.id}
            className="absolute flex h-36 min-w-0 flex-col rounded-lg border bg-card p-3 shadow-xs"
            style={{ left: x, top: y, width: layout.nodeWidth }}
          >
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {node.kind}
            </span>
            <button
              className="mt-2 truncate text-left text-sm font-medium hover:underline"
              onClick={() => onInspect(node)}
              title={node.label}
            >
              {node.label}
            </button>
            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
              {node.source.path}
            </p>
            <div className="mt-auto flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => onExplore(node)}>
                Explore
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onSource(node)}>
                Source
              </Button>
            </div>
          </article>
        ))}
      </div>
      {edges.length > 0 && (
        <details className="border-t bg-background p-3 text-xs">
          <summary className="cursor-pointer">
            Inspect {edges.length} connections and evidence
          </summary>
          <ul className="mt-3 space-y-2">
            {edges.map((edge) => (
              <li key={edge.id}>
                <button
                  className="text-left hover:underline"
                  onClick={() => {
                    const node = nodes.find((n) => n.id === edge.from);
                    if (node) onSource({ ...node, source: edge.source });
                  }}
                >
                  {nodes.find((n) => n.id === edge.from)?.label} → {edge.kind} →{" "}
                  {nodes.find((n) => n.id === edge.to)?.label} · {edge.evidence} · {edge.rule}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
