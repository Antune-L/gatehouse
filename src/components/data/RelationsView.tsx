import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import ELK from "elkjs/lib/elk.bundled.js";
import { KeyRound, Link2, Table2 } from "lucide-react";
import { useStore, type TableSubView } from "@/store";
import { allTables } from "@/lib/backend";
import { ViewTabs } from "@/components/workspace/ViewTabs";
import type { TableDef } from "@/lib/types";

interface RelNodeData extends Record<string, unknown> {
  table: TableDef;
  center: boolean;
  highlightColumns: string[];
  handles: string[];
}

function TableNode({ data }: NodeProps<Node<RelNodeData>>) {
  const { t } = useTranslation();
  const openTable = useStore((s) => s.openTable);
  const [showAll, setShowAll] = useState(false);
  const { table, center, highlightColumns, handles } = data;
  const keyCols = table.columns.filter(
    (c) => c.primaryKey || c.references || highlightColumns.includes(c.name)
  );
  const extra = table.columns.length - keyCols.length;
  const visibleCols = showAll ? table.columns : keyCols;
  return (
    <div
      className={
        "w-[210px] overflow-hidden rounded-lg border bg-panel shadow-xl " +
        (center ? "border-brand ring-2 ring-brand/30" : "border-border")
      }
    >
      <button
        onClick={() => openTable(table.name)}
        className={
          "flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[12.5px] font-semibold " +
          (center ? "bg-brand/15 text-brand" : "bg-panel-2 text-foreground")
        }
      >
        <Table2 className="h-3.5 w-3.5" />
        {table.name}
      </button>
      <div className="divide-y divide-border/40">
        {visibleCols.map((c) => (
          <div
            key={c.name}
            className="relative flex items-center gap-1.5 px-2.5 py-1 text-[11.5px]"
          >
            {handles.includes(`${c.name}-t`) && (
              <Handle
                type="target"
                position={Position.Left}
                id={`${c.name}-t`}
                style={{ background: "var(--border-strong)", width: 6, height: 6 }}
              />
            )}
            {c.primaryKey ? (
              <KeyRound className="h-3 w-3 text-warning" />
            ) : c.references ? (
              <Link2 className="h-3 w-3 text-info" />
            ) : (
              <span className="w-3" />
            )}
            <span className="text-foreground/90">{c.name}</span>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              {c.type}
            </span>
            {handles.includes(`${c.name}-s`) && (
              <Handle
                type="source"
                position={Position.Right}
                id={`${c.name}-s`}
                style={{ background: "var(--border-strong)", width: 6, height: 6 }}
              />
            )}
          </div>
        ))}
        {extra > 0 && (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="w-full px-2.5 py-1 text-left text-[10.5px] text-muted-foreground transition-colors hover:bg-panel-2 hover:text-foreground"
          >
            {showAll ? t("relations.showKeyCols") : t("relations.showAllCols", { n: extra })}
          </button>
        )}
      </div>
    </div>
  );
}

const nodeTypes = { table: TableNode };

const elk = new ELK();
const NODE_WIDTH = 210;
const NODE_HEADER_HEIGHT = 30;
const NODE_ROW_HEIGHT = 25;
const LAYER_SPACING = "120";
const NODE_SPACING = "48";

function estimateNodeHeight(d: RelNodeData): number {
  const keyCols = d.table.columns.filter(
    (c) => c.primaryKey || c.references || d.highlightColumns.includes(c.name)
  ).length;
  const hasExpandRow = keyCols < d.table.columns.length ? 1 : 0;
  return NODE_HEADER_HEIGHT + (keyCols + hasExpandRow) * NODE_ROW_HEIGHT;
}

export function RelationsView({
  tableName,
  subView,
  onSub,
}: {
  tableName: string;
  subView?: TableSubView;
  onSub?: (v: TableSubView) => void;
}) {
  const schema = useStore((s) => s.schema);
  const theme = useStore((s) => s.settings.theme);
  const tables = useMemo(() => allTables(schema), [schema]);
  const center = tables.find((t) => t.name === tableName);

  const { nodes, edges } = useMemo(() => {
    const empty: { nodes: Node<RelNodeData>[]; edges: Edge[] } = {
      nodes: [],
      edges: [],
    };
    if (!center) return empty;

    const outgoing = center.columns
      .filter((c) => c.references)
      .map((c) => ({ col: c.name, target: c.references!.table, targetCol: c.references!.column }));

    const incoming: { table: string; col: string; targetCol: string }[] = [];
    for (const t of tables) {
      if (t.name === center.name) continue;
      for (const c of t.columns) {
        if (c.references?.table === center.name)
          incoming.push({ table: t.name, col: c.name, targetCol: c.references.column });
      }
    }

    const nodes: Node<RelNodeData>[] = [];
    const edges: Edge[] = [];

    nodes.push({
      id: center.name,
      type: "table",
      position: { x: 340, y: 240 },
      data: {
        table: center,
        center: true,
        highlightColumns: [
          ...outgoing.map((o) => o.col),
          ...incoming.map((i) => i.targetCol),
        ],
        handles: [],
      },
    });

    const rightTargets = [...new Set(outgoing.map((o) => o.target))];
    rightTargets.forEach((name, i) => {
      const tdef = tables.find((t) => t.name === name);
      if (!tdef) return;
      nodes.push({
        id: name,
        type: "table",
        position: { x: 720, y: 80 + i * 200 },
        data: { table: tdef, center: false, highlightColumns: [], handles: [] },
      });
    });
    outgoing.forEach((o) => {
      edges.push({
        id: `out-${o.col}-${o.target}`,
        source: center.name,
        sourceHandle: `${o.col}-s`,
        target: o.target,
        targetHandle: `${o.targetCol}-t`,
        label: "n → 1",
        type: "default",
        animated: false,
        style: { stroke: "var(--info)" },
        labelStyle: { fill: "var(--muted-foreground)", fontSize: 10 },
        labelBgStyle: { fill: "var(--panel)" },
      });
    });

    const leftSources = [...new Set(incoming.map((i) => i.table))];
    leftSources.forEach((name, i) => {
      const tdef = tables.find((t) => t.name === name);
      if (!tdef) return;
      nodes.push({
        id: name,
        type: "table",
        position: { x: -40, y: 80 + i * 200 },
        data: { table: tdef, center: false, highlightColumns: [], handles: [] },
      });
    });
    incoming.forEach((inc) => {
      edges.push({
        id: `in-${inc.table}-${inc.col}`,
        source: inc.table,
        sourceHandle: `${inc.col}-s`,
        target: center.name,
        targetHandle: `${inc.targetCol}-t`,
        label: "1 → n",
        type: "default",
        style: { stroke: "var(--warning)" },
        labelStyle: { fill: "var(--muted-foreground)", fontSize: 10 },
        labelBgStyle: { fill: "var(--panel)" },
      });
    });

    const handleMap = new Map<string, Set<string>>();
    for (const e of edges) {
      if (e.sourceHandle) {
        const set = handleMap.get(e.source) ?? new Set<string>();
        set.add(e.sourceHandle);
        handleMap.set(e.source, set);
      }
      if (e.targetHandle) {
        const set = handleMap.get(e.target) ?? new Set<string>();
        set.add(e.targetHandle);
        handleMap.set(e.target, set);
      }
    }
    for (const n of nodes) {
      n.data.handles = Array.from(handleMap.get(n.id) ?? []);
    }

    return { nodes, edges };
  }, [center, tables]);

  // elkjs layered auto-layout (Decisions §8). The library is promise-only,
  // so the positioned nodes land in state and ReactFlow mounts once ready.
  const [layouted, setLayouted] = useState<Node<RelNodeData>[] | null>(null);
  useEffect(() => {
    if (nodes.length === 0) return;
    let cancelled = false;
    const graph = {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.spacing.nodeNode": NODE_SPACING,
        "elk.layered.spacing.nodeNodeBetweenLayers": LAYER_SPACING,
      },
      children: nodes.map((n) => ({
        id: n.id,
        width: NODE_WIDTH,
        height: estimateNodeHeight(n.data),
      })),
      edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
    };
    void elk
      .layout(graph)
      .then((g) => {
        if (cancelled) return;
        const pos = new Map(
          (g.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }])
        );
        setLayouted(
          nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position }))
        );
      })
      .catch(() => {
        if (!cancelled) setLayouted(nodes);
      });
    return () => {
      cancelled = true;
    };
  }, [nodes, edges]);

  const { t } = useTranslation();
  if (!center || !layouted) return null;

  return (
    <div className="flex h-full w-full flex-col">
      {subView && onSub && (
        <div className="flex h-11 shrink-0 items-center border-b border-border px-3">
          <ViewTabs value={subView} onChange={onSub} />
        </div>
      )}
      <div className="relative min-h-0 flex-1">
      <ReactFlow
        key={center.name}
        defaultNodes={layouted}
        defaultEdges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.3}
        colorMode={theme === "blue" ? "dark" : "light"}
        nodesDraggable
        nodesConnectable={false}
        edgesReconnectable={false}
        edgesFocusable={false}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color="var(--border)"
        />
        <Controls className="!bg-panel-2 !border-border" showInteractive={false} />
      </ReactFlow>
      <div className="pointer-events-none absolute bottom-4 left-4 rounded-md border border-border bg-elevated/90 px-3 py-2 text-[11px] text-muted-foreground">
        <div className="mb-1 font-medium text-foreground">{t("relations.hintTitle")}</div>
        {t("relations.hintBody")}
      </div>
      </div>
    </div>
  );
}
