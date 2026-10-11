"use client";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { stepName } from "@/components/ui/names";
import { STATE_COLOR, STATE_LABEL } from "@/components/ui/tokens";
import type { AttemptView, NodeView } from "@/lib/types";

export const CARD_W = 208;
export const CARD_H = 68;

export interface CardData extends Record<string, unknown> {
  node: NodeView;
  latest?: AttemptView;
  flashAt?: number;
  swapAt?: number;
  selected: boolean;
  dir?: "LR" | "TB";
}

export type CardNode = Node<CardData, "card">;

function CardImpl({ data }: NodeProps<CardNode>) {
  const { node, flashAt, swapAt, selected, dir = "LR" } = data;
  const color = STATE_COLOR[node.state];
  const live = node.state === "running" || node.state === "verifying" || node.state === "queued" || node.state === "swapping";
  // Keyed by the swap time, so each swap replays the one-shot regrow animations.
  const regrowing = swapAt !== undefined;
  const recovered = node.state === "passed" && node.swaps > 0;
  const title = cardTitle(node);
  const agentName = node.currentAgent?.name ?? (node.placeholder ? "Starts after the crawl" : node.kind === "builtin" ? "Axolotl" : "Not started");
  const status = node.restored ? "Restored" : recovered ? "Recovered" : STATE_LABEL[node.state];
  const statusColor = recovered ? "var(--regrow)" : color;

  return (
    <div
      key={flashAt ?? "steady"}
      className={`relative overflow-hidden rounded-[10px] border bg-panel ${flashAt ? "anim-flash" : ""}`}
      style={
        {
          "--state": color,
          width: CARD_W,
          height: CARD_H,
          borderColor: selected ? "var(--focus)" : live ? `color-mix(in srgb, ${color} 40%, var(--line))` : "var(--line)",
          borderStyle: node.placeholder ? "dashed" : "solid",
          boxShadow: selected ? "0 0 0 3px color-mix(in srgb, var(--focus) 18%, transparent)" : "var(--shadow)",
          opacity: node.placeholder || node.state === "idle" ? 0.75 : 1,
        } as React.CSSProperties
      }
    >
      <Handle type="target" position={dir === "TB" ? Position.Top : Position.Left} />
      <div className="flex h-full flex-col justify-center px-3">
        <div className="truncate text-[13px] font-semibold text-ink">{title}</div>
        <div
          key={`${node.currentAgent?.agentId ?? "none"}-${swapAt ?? 0}`}
          className={`truncate text-[12px] text-muted ${regrowing ? "anim-regrow" : ""}`}
        >
          {agentName}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[11.5px] font-medium" style={{ color: statusColor }}>
          <span className={`inline-block h-[7px] w-[7px] rounded-full ${live ? "anim-pulse" : ""}`} style={{ background: statusColor }} />
          {status}
        </div>
      </div>
      {regrowing && <div key={swapAt} className="pointer-events-none absolute inset-0 rounded-[10px] anim-regrow-glow" />}
      {live && <div className="scanbar" />}
      <Handle type="source" position={dir === "TB" ? Position.Bottom : Position.Right} />
    </div>
  );
}

function cardTitle(node: NodeView): string {
  return stepName(node);
}

export const NodeCard = memo(CardImpl);
