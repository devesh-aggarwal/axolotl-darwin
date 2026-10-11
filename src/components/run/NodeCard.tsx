"use client";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { stepName } from "@/components/ui/names";
import { STATE_COLOR, STATE_LABEL } from "@/components/ui/tokens";
import type { AttemptView, NodeView } from "@/lib/types";

export const CARD_W = 232;
export const CARD_H = 74;

export interface CardData extends Record<string, unknown> {
  node: NodeView;
  latest?: AttemptView;
  flashAt?: number;
  swapAt?: number;
  selected: boolean;
  dir?: "LR" | "TB";
  /** Darwin runs mix real and simulated agents: say which one is on each card. */
  showSource?: boolean;
}

export type CardNode = Node<CardData, "card">;

/** A small regrown limb: the mark a healed step keeps for the rest of the run. */
function RegrowMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <path d="M3 13c0-5 3-8 8-8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M8.5 2.5 11 5l-2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CardImpl({ data }: NodeProps<CardNode>) {
  const { node, flashAt, swapAt, selected, dir = "LR", showSource = false } = data;
  const color = STATE_COLOR[node.state];
  const live = node.state === "running" || node.state === "verifying" || node.state === "queued" || node.state === "swapping";
  // Keyed by the swap time, so each swap replays the one-shot regrow animations.
  const regrowing = swapAt !== undefined;
  const recovered = node.state === "passed" && node.swaps > 0;
  const dormant = node.placeholder || node.state === "idle" || node.state === "cancelled";
  const title = cardTitle(node);
  const agentName = node.currentAgent?.name ?? (node.placeholder ? "Starts after the crawl" : node.kind === "builtin" ? "Axolotl" : "Not started");
  // With a source tag on the card there's no room for the swap count; the inspector has it.
  const swapCount = showSource ? "" : ` · ${node.swaps} ${node.swaps === 1 ? "swap" : "swaps"}`;
  const status = node.restored ? "Restored" : recovered ? `Recovered${swapCount}` : STATE_LABEL[node.state];
  // Grey dots stay grey, but their words use readable ink.
  const statusColor = recovered ? "var(--regrow)" : dormant ? "var(--muted)" : color;

  return (
    <div
      key={flashAt ?? "steady"}
      className={`relative overflow-hidden rounded-[12px] border ${flashAt ? "anim-flash" : ""}`}
      style={
        {
          "--state": color,
          width: CARD_W,
          height: CARD_H,
          background: recovered ? "var(--regrow-soft)" : "var(--panel)",
          borderColor: selected
            ? "var(--focus)"
            : recovered
              ? "var(--regrow-line)"
              : live
                ? `color-mix(in srgb, ${color} 40%, var(--line))`
                : "var(--line)",
          borderStyle: node.placeholder ? "dashed" : "solid",
          boxShadow: selected ? "0 0 0 3px color-mix(in srgb, var(--focus) 18%, transparent)" : "var(--shadow)",
          opacity: dormant ? 0.8 : 1,
        } as React.CSSProperties
      }
    >
      <Handle type="target" position={dir === "TB" ? Position.Top : Position.Left} />
      <div className="flex h-full flex-col justify-center px-3.5">
        <div className="truncate text-[15px] font-semibold leading-tight tracking-[-0.01em] text-ink">{title}</div>
        <div
          key={`${node.currentAgent?.agentId ?? "none"}-${swapAt ?? 0}`}
          className={`mt-0.5 truncate text-[13px] leading-tight text-muted ${regrowing ? "anim-regrow" : ""}`}
        >
          {agentName}
        </div>
        <div className="mt-1.5 flex items-center gap-1.5 text-[12.5px] font-semibold leading-none" style={{ color: statusColor }}>
          {recovered ? (
            <RegrowMark />
          ) : (
            <span
              className={`inline-block h-[8px] w-[8px] shrink-0 rounded-full ${live ? "anim-pulse" : ""}`}
              style={{ background: color }}
            />
          )}
          <span className="truncate">{status}</span>
          {showSource && node.currentAgent && node.kind === "agent" && node.currentAgent.source !== "mock" && <SourceTag />}
        </div>
      </div>
      {regrowing && <div key={swapAt} className="pointer-events-none absolute inset-0 rounded-[12px] anim-regrow-glow" />}
      {live && <div className="scanbar" />}
      <Handle type="source" position={dir === "TB" ? Position.Bottom : Position.Right} />
    </div>
  );
}

/** Marks a step run by a real agent found on Darwin. */
function SourceTag() {
  return (
    <span
      className="ml-auto shrink-0 rounded-full border px-1.5 py-[2px] text-[11.5px] font-medium leading-none"
      style={{ borderColor: "color-mix(in srgb, var(--s-running) 35%, var(--line))", color: "var(--s-running)" }}
      title="A real agent found on Darwin ran this step"
    >
      Real
    </span>
  );
}

function cardTitle(node: NodeView): string {
  return stepName(node);
}

export const NodeCard = memo(CardImpl);
