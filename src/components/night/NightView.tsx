"use client";
// Overnight time-lapse: a simulated night of audit runs with failures injected, run twice with
// the same seeds (without and with Axolotl) and filled in live as ticks arrive over SSE.
import { useMemo, useState, type ReactNode } from "react";
import type { TimelapseView } from "@/components/api";
import { SidePanel } from "@/components/night/SidePanel";
import { UsableChart } from "@/components/night/UsableChart";
import { ZERO_SIDE, deriveRuns, fmtCount, plural, sortTicks } from "@/components/night/derive";
import { usePlayhead, useTween } from "@/components/night/useTween";
import { useAxolotl } from "@/components/store";
import { Button, Empty, Segmented } from "@/components/ui/primitives";

type Length = "30000" | "60000" | "120000";

const LENGTHS: { value: Length; label: string; words: string }[] = [
  { value: "30000", label: "30 s", words: "about 30 seconds" },
  { value: "60000", label: "1 min", words: "about a minute" },
  { value: "120000", label: "2 min", words: "about two minutes" },
];

export function NightView() {
  const { state, actions } = useAxolotl();
  const tl = state.timelapse;
  const [runs, setRuns] = useState("50");
  const [chaosRate, setChaosRate] = useState(0.1);
  const [length, setLength] = useState<Length>("60000");
  const [starting, setStarting] = useState(false);
  const [cancelledId, setCancelledId] = useState<string | null>(null);

  const runsN = Math.min(200, Math.max(5, Math.round(Number(runs)) || 50));
  const running = Boolean(tl?.running);
  const cancelling = running && cancelledId !== null && cancelledId === tl?.id;

  const start = async () => {
    setStarting(true);
    setCancelledId(null);
    await actions.startTimelapse({ runs: runsN, chaosRate, durationMs: Number(length) });
    setStarting(false);
  };

  const cancel = () => {
    if (tl) setCancelledId(tl.id);
    void actions.cancelTimelapse();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-7 gap-y-3 border-b border-line bg-panel px-4 py-3">
        <Field label="Runs" title="Audit runs in the simulated night">
          <input
            type="number"
            min={5}
            max={200}
            step={5}
            value={runs}
            disabled={running}
            onChange={(e) => setRuns(e.target.value)}
            onBlur={() => setRuns(String(runsN))}
            aria-label="Runs"
            className="h-9 w-[72px] rounded-[8px] border border-line-strong bg-panel px-3 text-[14.5px] text-ink tabular outline-none focus:border-[var(--focus)] focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus)_15%,transparent)] disabled:opacity-40"
          />
        </Field>
        <Field label="Failure rate" title="Chance that an agent call errors, stalls or returns bad output">
          <input
            type="range"
            min={0}
            max={0.6}
            step={0.05}
            value={chaosRate}
            disabled={running}
            onChange={(e) => setChaosRate(Number(e.target.value))}
            aria-label="Failure rate"
            className="w-[100px] accent-[var(--s-failed)] disabled:opacity-40"
          />
          <span className="w-[34px] text-[14px] text-ink-2 tabular">{Math.round(chaosRate * 100)}%</span>
        </Field>
        <Field label="Length" title="How long the whole night takes to play back">
          <Segmented value={length} onChange={setLength} options={LENGTHS.map(({ value, label }) => ({ value, label }))} disabled={running} />
        </Field>
        <div className="ml-auto flex items-center gap-2">
          {running && (
            <Button tone="ghost" onClick={cancel} disabled={cancelling}>
              {cancelling ? "Stopping…" : "Cancel"}
            </Button>
          )}
          <Button tone="primary" onClick={start} disabled={starting || running}>
            {running ? "Running…" : "Start"}
          </Button>
        </div>
      </div>

      {!tl ? (
        <Empty title="Simulate a night of audits">
          Runs {runsN} website audits back to back with random agent failures, once on their own and once with Axolotl, played back in{" "}
          {LENGTHS.find((l) => l.value === length)?.words}.
        </Empty>
      ) : (
        <NightBody key={tl.id} tl={tl} />
      )}
    </div>
  );
}

/**
 * Everything below the controls reads ONE tick: the one at the playhead. The clock, headline,
 * percentages, "x of y", strips and chart therefore always describe the same moment of the night.
 */
function NightBody({ tl }: { tl: TimelapseView }) {
  const { state } = useAxolotl();
  const running = tl.running;
  const ticks = useMemo(() => sortTicks(tl.ticks), [tl.ticks]);
  const newest = ticks.length ? ticks[ticks.length - 1] : undefined;
  const total = newest?.total ?? tl.options.runs;
  const playhead = usePlayhead(newest?.index ?? 0);
  const shown = useMemo(() => ticks.filter((t) => t.index <= playhead), [ticks, playhead]);
  const cur = shown.length ? shown[shown.length - 1] : undefined;
  const without = cur?.without ?? ZERO_SIDE;
  const withAx = cur?.with ?? ZERO_SIDE;
  const withoutMarks = useMemo(() => deriveRuns(shown, "without"), [shown]);
  const withMarks = useMemo(() => deriveRuns(shown, "with"), [shown]);

  // Both rework counters tween with the same timing; the headline is their on-screen difference.
  const withoutHours = Math.round(useTween(without.wastedHours, 600));
  const withHours = Math.round(useTween(withAx.wastedHours, 600));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
      <div className="flex shrink-0 flex-wrap items-center gap-x-10 gap-y-3 px-1 pt-5 pb-2">
        <div className="shrink-0">
          <Clock value={cur?.clock ?? "23:00"} running={running} />
          <div className="mt-1.5 text-[14px] text-muted tabular">{progressLabel(cur?.index ?? 0, total, running)}</div>
        </div>
        <div className="min-w-[280px] max-w-[760px] flex-1">
          <Headline saved={withoutHours - withHours} anyRework={withoutHours + withHours > 0} started={Boolean(cur?.index)} running={running} />
          <p className="mt-1.5 max-w-[64ch] text-[14.5px] leading-relaxed text-muted">
            A simulated night. Each audit runs twice with the same failures injected: once on its own, once with Axolotl. Rework is
            estimated at {state.boot?.defaults.manualAuditHours ?? 6} hours for every audit that has to be redone by hand.
          </p>
        </div>
      </div>

      <div className="grid shrink-0 gap-3 md:grid-cols-2">
        <SidePanel side="without" data={without} hours={withoutHours} marks={withoutMarks} total={total} running={running} />
        <SidePanel side="with" data={withAx} hours={withHours} marks={withMarks} total={total} running={running} />
      </div>

      <section className="card flex min-h-[240px] flex-1 flex-col px-4 pb-3 pt-4">
        <h2 className="px-1 text-[14px] font-medium text-ink">
          Usable reports through the night <span className="font-normal text-muted">out of {fmtCount(total)} runs</span>
        </h2>
        <div className="relative mt-3 min-h-0 flex-1">
          <div className="absolute inset-0">
            <UsableChart ticks={shown} total={total} />
          </div>
        </div>
      </section>
    </div>
  );
}

/** The one number that matters: hours of manual rework Axolotl avoided. */
function Headline({ saved, anyRework, started, running }: { saved: number; anyRework: boolean; started: boolean; running: boolean }) {
  const base = "text-[28px] font-semibold leading-tight tracking-[-0.02em]";
  const cls = `${base} text-ink`;
  if (!started) return <h2 className={`${base} text-muted`}>{running ? "The night is starting…" : "No run finished"}</h2>;
  if (saved <= 0 && !running) {
    return <h2 className={cls}>{anyRework ? "Axolotl saved no rework tonight" : "Nothing needed redoing tonight"}</h2>;
  }
  const hours = (
    <span className="tabular">
      {fmtCount(Math.max(0, saved))} {plural(Math.max(0, saved), "hour", "hours")}
    </span>
  );
  return running ? (
    <h2 className={cls}>Axolotl has saved an estimated {hours} of rework so far</h2>
  ) : (
    <h2 className={cls}>Axolotl saved an estimated {hours} of rework tonight</h2>
  );
}

function progressLabel(done: number, total: number, running: boolean): string {
  if (running) return done ? `Run ${done} of ${total}` : `Starting ${total} runs…`;
  if (done >= total) return `All ${total} runs done`;
  return `Stopped after ${done} of ${total}`;
}

function Clock({ value, running }: { value: string; running: boolean }) {
  const [hh, mm] = value.split(":");
  return (
    <div className="text-[44px] font-semibold leading-none tracking-[-0.02em] text-ink tabular" aria-label={`Simulated time ${value}`}>
      {hh}
      <span className={running ? "anim-blink" : undefined}>:</span>
      {mm}
    </div>
  );
}

function Field({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5" title={title}>
      <span className="text-[13.5px] text-muted">{label}</span>
      {children}
    </div>
  );
}
