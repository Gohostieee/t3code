export function codebaseGraphLayout<Node extends { readonly id: string }>(
  nodes: ReadonlyArray<Node>,
  edges: ReadonlyArray<{ readonly from: string; readonly to: string }>,
  viewport: { width: number; height: number },
) {
  const incoming = new Set(edges.map((edge) => edge.to));
  const outgoing = new Set(edges.map((edge) => edge.from));
  const columns = [
    nodes.filter((node) => !incoming.has(node.id)),
    nodes.filter((node) => incoming.has(node.id) && outgoing.has(node.id)),
    nodes.filter((node) => incoming.has(node.id) && !outgoing.has(node.id)),
  ].filter((column) => column.length);
  const padding = 32;
  const columnGap = 72;
  const rowGap = 24;
  const nodeHeight = 168;
  const columnCount = Math.max(1, columns.length);
  const width = Math.max(
    viewport.width,
    padding * 2 + columns.length * 236 + Math.max(0, columns.length - 1) * columnGap,
  );
  const height = Math.max(
    viewport.height,
    padding * 2,
    ...columns.map(
      (column) => padding * 2 + column.length * nodeHeight + (column.length - 1) * rowGap,
    ),
  );
  const nodeWidth = (width - padding * 2 - (columnCount - 1) * columnGap) / columnCount;
  return {
    width,
    height,
    nodeWidth,
    nodeHeight,
    nodes: columns.flatMap((column, x) =>
      column.map((node, y) => ({
        node,
        x: padding + x * (nodeWidth + columnGap),
        y:
          column.length === 1
            ? (height - nodeHeight) / 2
            : padding + (y * (height - padding * 2 - nodeHeight)) / (column.length - 1),
      })),
    ),
  };
}
