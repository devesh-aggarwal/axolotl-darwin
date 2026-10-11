"use client";
import { useRef } from "react";
import { CATEGORY_LABEL, VERDICT } from "@/components/ui/tokens";
import { useFlip } from "@/components/evolution/hooks";
import { describeRow, scoreColor, sourceLabel, type Board, type BoardRow } from "@/components/evolution/leaderboard";
import { ReliabilityBar, Sparkline, TickingScore } from "@/components/evolution/marks";

export function CapabilityBoard({ board }: { board: Board }) {
  const listRef = useRef<HTMLOListElement>(null);
  useFlip(listRef, board.rows.map((r) => r.agentId).join("|"));
  const label = CATEGORY_LABEL[board.capability] ?? board.capability;

  return (
    <section className="card flex min-w-0 flex-col" aria-label={`${label} leaderboard`}>
      <header className="flex items-baseline justify-between gap-3 px-4 pb-1.5 pt-3.5">
        <h2 className="text-[15px] font-semibold text-ink">{label}</h2>
        <span className="tabular text-[13px] text-muted">
          {board.attempts ? `${board.attempts.toLocaleString()} ${board.attempts === 1 ? "attempt" : "attempts"}` : "No attempts yet"}
        </span>
      </header>
      {board.rows.length ? (
        <ol ref={listRef} className="relative px-2 pb-2">
          {board.rows.map((r, i) => (
            <Row key={r.agentId} row={r} rank={i + 1} />
          ))}
        </ol>
      ) : (
        <p className="px-4 pb-4 text-[13.5px] text-muted">No agent has run this step yet.</p>
      )}
    </section>
  );
}

function Row({ row, rank }: { row: BoardRow; rank: number }) {
  const color = scoreColor(row.score);
  const verdict = row.verdict ? VERDICT[row.verdict] : null;
  const kind = sourceLabel(row);

  return (
    <li
      data-flip={row.agentId}
      title={describeRow(row)}
      className="relative grid grid-cols-[16px_minmax(0,1fr)_48px_64px] items-center gap-x-3 rounded-[6px] bg-panel px-2 py-2.5 transition-colors hover:bg-panel-2"
    >
      <span className={`tabular text-right text-[13px] ${rank === 1 && row.attempts ? "text-ink" : "text-muted"}`}>{rank}</span>
      <div className="min-w-0">
        <div className="line-clamp-2 break-words text-[14px] leading-snug text-ink">{row.name}</div>
        <div className="mt-0.5 text-[12.5px] text-muted">
          {kind}
          {verdict && (
            <>
              {" · "}
              <span style={{ color: verdict.color }}>{verdict.label}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex flex-col items-end gap-1.5">
        {row.attempts ? (
          <>
            <TickingScore value={row.score} />
            <ReliabilityBar value={row.score} color={color} width={48} />
          </>
        ) : (
          <span className="text-[13.5px] text-muted" title="No attempts yet, so this is only the starting score">
            New
          </span>
        )}
      </div>
      <Sparkline points={row.history} color={color} width={64} height={28} />
    </li>
  );
}
