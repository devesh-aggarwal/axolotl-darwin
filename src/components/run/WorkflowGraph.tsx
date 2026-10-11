"use client";
import { Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, applyNodeChanges, useNodesInitialized, useReactFlow, type Edge, type NodeChange } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CARD_H, CARD_W, NodeCard, type CardNode } from "@/components/run/NodeCard";
import { useAxolotl } from "@/components/store";
import { stepName } from "@/components/ui/names";
import { STATE_COLOR } from "@/components/ui/tokens";
import type { NodeView } from "@/lib/types";

const nodeTypes = { card: NodeCard };

const COL = { crawl: 0, a11y: 280, perf: 540, site: 800, merge: 1060, prioritize: 1310, fixplan: 1560 };
const ROW = 92;
const SITE_TEMPLATES = ["seo", "security", "links"];

function indexOf(node: NodeView): number {
  const tail = node.id.split(":").pop() ?? "0";
  return tail === "*" ? -1 : Number(tail) || 0;
}

export type Direction = "LR" | "TB";

/** Deterministic layout. LR: the spine runs left to right and pages are rows.
    TB (tall, narrow screens): the spine runs top to bottom and pages are columns. */
function layout(nodes: NodeView[], dir: Direction): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const pages = Math.max(1, ...nodes.filter((n) => n.templateId === "a11y" || n.templateId === "perf").map((n) => indexOf(n) + 1));
  if (dir === "TB") {
    const colW = CARD_W + 20;
    const width = Math.max(pages, SITE_TEMPLATES.length) * colW;
    const center = width / 2 - CARD_W / 2;
    const left = (width - pages * colW) / 2;
    const Y = { crawl: 0, a11y: 120, perf: 220, site: 350, merge: 480, prioritize: 580, fixplan: 680 };
    for (const n of nodes) {
      if (n.templateId === "a11y" || n.templateId === "perf") {
        const y = n.templateId === "a11y" ? Y.a11y : Y.perf;
        pos.set(n.id, { x: n.placeholder ? center : left + indexOf(n) * colW, y });
      } else if (SITE_TEMPLATES.includes(n.templateId)) {
        const i = SITE_TEMPLATES.indexOf(n.templateId);
        pos.set(n.id, { x: center + (i - 1) * (colW + 10), y: Y.site });
      } else {
        pos.set(n.id, { x: center, y: Y[n.templateId as keyof typeof Y] ?? 0 });
      }
    }
    return pos;
  }
  const height = Math.max(pages, SITE_TEMPLATES.length) * ROW;
  const mid = height / 2 - ROW / 2;
  for (const n of nodes) {
    if (n.templateId === "a11y" || n.templateId === "perf") {
      const x = n.templateId === "a11y" ? COL.a11y : COL.perf;
      pos.set(n.id, { x, y: n.placeholder ? mid : indexOf(n) * ROW + (height - pages * ROW) / 2 });
    } else if (SITE_TEMPLATES.includes(n.templateId)) {
      const i = SITE_TEMPLATES.indexOf(n.templateId);
      pos.set(n.id, { x: COL.site, y: mid + (i - 1) * ROW * 1.15 });
    } else {
      const x = COL[n.templateId as keyof typeof COL] ?? 0;
      pos.set(n.id, { x, y: mid });
    }
  }
  return pos;
}

interface Size {
  w: number;
  h: number;
}

const FIT = { padding: 0.08, maxZoom: 1.15, duration: 400 } as const;

function Graph({ dir, size, coverRight }: { dir: Direction; size: Size; coverRight: number }) {
  const { state, actions } = useAxolotl();
  const { fitView, setCenter, getZoom } = useReactFlow();
  const measured = useNodesInitialized();
  const list = useMemo(() => Object.values(state.nodes), [state.nodes]);
  const positions = useMemo(() => layout(list, dir), [list, dir]);
  const showSource = state.run?.config.client === "darwin" || state.run?.config.realAgents === true;

  const computed: CardNode[] = useMemo(
    () =>
      list.map((n) => {
        const attempts = state.attempts[n.id];
        return {
          id: n.id,
          type: "card",
          position: positions.get(n.id) ?? { x: 0, y: 0 },
          // Fixed size: React Flow can show the node immediately without waiting to measure it.
          width: CARD_W,
          height: CARD_H,
          draggable: false,
          selectable: true,
          data: {
            node: n,
            latest: attempts?.[attempts.length - 1],
            flashAt: state.flashes[n.id],
            swapAt: state.swaps[n.id]?.at,
            selected: state.selectedNodeId === n.id,
            dir,
            showSource,
          },
        };
      }),
    [list, positions, state.attempts, state.flashes, state.swaps, state.selectedNodeId, dir, showSource],
  );

  // React Flow writes measurements (size, handle positions) back through onNodesChange.
  // Keep them across our re-renders, or edges lose their anchors.
  const [flowNodes, setFlowNodes] = useState<CardNode[]>([]);
  useEffect(() => {
    // Syncing derived graph state into React Flow's controlled node list is the intended use here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFlowNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return computed.map((n) => {
        const old = byId.get(n.id);
        return old ? { ...old, position: n.position, data: n.data, width: n.width, height: n.height } : n;
      });
    });
  }, [computed]);
  const onNodesChange = useCallback(
    (changes: NodeChange<CardNode>[]) =>
      setFlowNodes((nds) => applyNodeChanges(changes.filter((c) => c.type === "dimensions" || c.type === "select"), nds)),
    [],
  );

  const edges: Edge[] = useMemo(() => {
    const out: Edge[] = [];
    for (const n of list) {
      for (const dep of n.dependsOn) {
        const src = state.nodes[dep];
        if (!src) continue;
        const flowing = (src.state === "passed" || src.state === "partial") && ["queued", "running", "verifying", "swapping"].includes(n.state);
        const done = src.state === "passed" && (n.state === "passed" || n.state === "partial");
        const broken = src.state === "failed";
        out.push({
          id: `${dep}->${n.id}`,
          source: dep,
          target: n.id,
          ariaLabel: `${stepName(src)} to ${stepName(n)}`,
          type: "smoothstep",
          className: flowing ? "flowing" : undefined,
          style: {
            stroke: broken ? "var(--s-failed)" : flowing ? STATE_COLOR[n.state] : done ? "color-mix(in srgb, var(--s-passed) 45%, var(--line-strong))" : "var(--line-strong)",
            strokeWidth: flowing ? 2 : 1.4,
            opacity: broken ? 0.5 : 1,
          },
        });
      }
    }
    return out;
  }, [list, state.nodes]);

  // Re-fit once React Flow has measured the nodes: on a new node set (fan-out after the crawl,
  // a new run), when the canvas resizes, and when the side panel stops covering the graph.
  const signature = `${dir}|${list.map((n) => n.id).sort().join("|")}|${Math.round(size.w / 40)}x${Math.round(size.h / 40)}|${coverRight > 0 ? "covered" : "clear"}`;
  const lastSig = useRef("");
  useEffect(() => {
    if (!measured || signature === lastSig.current) return;
    lastSig.current = signature;
    // Animated fits run on animation frames, which background tabs pause: snap instead when hidden.
    // A second pass catches cards that were added in the same tick and measured a moment later.
    const fit = () => void fitView(document.hidden ? { ...FIT, duration: 0 } : FIT);
    const t = setTimeout(fit, 80);
    const again = setTimeout(fit, 450);
    return () => {
      clearTimeout(t);
      clearTimeout(again);
    };
  }, [signature, measured, fitView]);

  // When the inspector floats over the graph (narrow screens), keep the selected step in view.
  const selected = state.selectedNodeId;
  useEffect(() => {
    if (!selected || coverRight <= 0) return;
    const p = positions.get(selected);
    if (!p) return;
    const zoom = getZoom();
    void setCenter(p.x + CARD_W / 2 + coverRight / (2 * zoom), p.y + CARD_H / 2, { zoom, duration: 300 });
  }, [selected, coverRight, positions, getZoom, setCenter]);

  return (
    <ReactFlow
      nodes={flowNodes}
      onNodesChange={onNodesChange}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, n) => actions.selectNode(n.id)}
      onPaneClick={() => actions.selectNode(null)}
      nodesDraggable={false}
      nodesConnectable={false}
      edgesFocusable={false}
      minZoom={0.3}
      maxZoom={1.6}
      fitView
      fitViewOptions={FIT}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="var(--canvas-dot)" />
      <Controls showInteractive={false} position="bottom-left" />
    </ReactFlow>
  );
}

/** `coverRight`: pixels of the canvas hidden under a floating side panel (narrow screens). */
export function WorkflowGraph({ coverRight = 0 }: { coverRight?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Top-to-bottom reads best on most screens; left-to-right only on very wide, short canvases.
  const dir: Direction | null = size ? (size.w > size.h * 2.2 ? "LR" : "TB") : null;
  return (
    <div ref={ref} className="absolute inset-0">
      {dir && size && (
        // Remount on direction change so React Flow re-measures handle positions.
        <ReactFlowProvider key={dir}>
          <Graph dir={dir} size={size} coverRight={coverRight} />
        </ReactFlowProvider>
      )}
    </div>
  );
}
