"use client";
import { Fragment, useEffect, useState } from "react";
import { api } from "@/components/api";
import { RunSummaryPanel } from "@/components/run/RunSummaryPanel";
import { useAxolotl } from "@/components/store";
import { Button, Chip, Details, Meter } from "@/components/ui/primitives";
import { issueText, stepName } from "@/components/ui/names";
import { FAILURE_PHRASE, LAYER_NAME, SEVERITY_COLOR, STATE_COLOR, STATE_LABEL, VERDICT, fmtCents, fmtMs, shortPath, tierLabel } from "@/components/ui/tokens";
import type { AgentStats, AttemptView, AuditOutput, CrawlOutput, FixPlanOutput, MergeOutput, NodeView, PrioritizedOutput } from "@/lib/types";
import { useCopy } from "@/components/ui/copy";

export function Inspector() {
  const { state } = useAxolotl();
  const node = state.selectedNodeId ? state.nodes[state.selectedNodeId] : undefined;
  if (!node) return <RunSummaryPanel />;
  return <NodeInspector key={node.id} node={node} />;
}

function NodeInspector({ node }: { node: NodeView }) {
  const { state, actions } = useAxolotl();
  const attempts = state.attempts[node.id] ?? [];
  const runRunning = state.run?.status === "running";
  const canBreak = runRunning && node.kind === "agent" && !node.placeholder && !["passed", "failed", "partial", "cancelled"].includes(node.state);
  const recovered = node.state === "passed" && node.swaps > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-4 pb-4 pt-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[16px] font-semibold text-ink">{prettyLabel(node)}</div>
            <div className="mt-1">
              <Chip color={recovered ? "var(--regrow)" : STATE_COLOR[node.state]}>
                {node.restored ? "Restored from checkpoint" : recovered ? "Recovered automatically" : STATE_LABEL[node.state]}
              </Chip>
            </div>
          </div>
          <button className="text-[20px] leading-none text-muted hover:text-ink" onClick={() => actions.selectNode(null)} aria-label="Close">
            ×
          </button>
        </div>
        {node.kind === "agent" && !node.placeholder && canBreak && (
          <div className="mt-4 rounded-[10px] bg-panel-2 p-3">
            <div className="text-[12.5px] text-muted">Try breaking this step</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button size="sm" tone="danger" onClick={() => actions.injectFault(node.id, "kill")}>
                Crash agent
              </Button>
              <Button size="sm" tone="danger" onClick={() => actions.injectFault(node.id, "timeout")}>
                Make it hang
              </Button>
              <Button size="sm" tone="danger" onClick={() => actions.injectFault(node.id, "corrupt")}>
                Corrupt output
              </Button>
            </div>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {node.kind === "agent" && (
          <Section title="What happened">
            <Story attempts={attempts} node={node} />
          </Section>
        )}
        {(node.state === "passed" || node.state === "partial") && (
          <Section title="Result">
            <Output node={node} />
          </Section>
        )}
        {node.kind === "agent" && !node.placeholder && (
          <Section title="Agents found">
            <AgentsFound node={node} />
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-line pt-4 pb-2">
      <div className="mb-3 text-[13px] font-medium text-ink">{title}</div>
      {children}
    </div>
  );
}

function prettyLabel(node: NodeView): string {
  return stepName(node);
}

// ---------- story ----------

function Story({ attempts, node }: { attempts: AttemptView[]; node: NodeView }) {
  const copy = useCopy();
  if (!attempts.length) {
    return <div className="text-[13px] text-muted">{node.placeholder ? "Starts once the crawl finds the pages." : "Not started yet."}</div>;
  }
  return (
    <ol className="flex flex-col">
      {attempts.map((a, i) => (
        <Fragment key={a.id}>
          {i > 0 && (
            <li className="flex items-center gap-2 py-1.5 pl-[3px] text-[12.5px] font-medium" style={{ color: "var(--regrow)" }}>
              <span>↻</span> {copy.switched(a.agent.name)}
            </li>
          )}
          <StoryStep a={a} />
        </Fragment>
      ))}
      {node.state === "failed" && node.error && (
        <li className="mt-2 rounded-[8px] bg-[color-mix(in_srgb,var(--s-failed)_7%,var(--panel))] px-3 py-2 text-[12.5px] text-[var(--s-failed)]">
          Every agent found for this step failed. The rest of the run keeps going and the report marks it as partial.
        </li>
      )}
    </ol>
  );
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** How an agent ran, when that's worth saying: only Darwin runs mix real and simulated agents. */
function kindLabel(a: AttemptView, runClient: string | undefined): string | null {
  if (a.agent.source === "direct") return "Called directly at its own address";
  if (a.agent.source === "darwin") return "Ran through Darwin";
  return runClient === "darwin" ? "Simulated backup" : null;
}

function StoryStep({ a }: { a: AttemptView }) {
  const { state } = useAxolotl();
  const kind = kindLabel(a, state.run?.config.client);
  const failedLayer = a.verification?.layers.find((l) => !l.pass && !l.skipped);
  let icon = "●";
  let color = "var(--s-running)";
  let text = `${a.agent.name} is working on it`;
  if (a.outcome === "verifying") {
    color = "var(--s-verifying)";
    text = `Checking ${a.agent.name}'s output`;
  } else if (a.outcome === "passed") {
    icon = "✓";
    color = "var(--s-passed)";
    const n = a.verification?.layers.length ?? 0;
    text = n > 1 ? `${a.agent.name} passed all ${n} checks` : n === 1 ? `${a.agent.name} passed the check` : `${a.agent.name} finished`;
  } else if (a.outcome === "hard_failure") {
    icon = "✕";
    color = "var(--s-failed)";
    text = `${a.agent.name} ${a.failureType ? FAILURE_PHRASE[a.failureType] : "failed"}`;
  } else if (a.outcome === "silent_failure") {
    icon = "!";
    color = "var(--s-partial)";
    text = `${a.agent.name} returned bad output${failedLayer ? `, caught by the ${LAYER_NAME[failedLayer.layer]?.toLowerCase()} check` : ""}`;
  }
  return (
    <li className="anim-rise py-1.5">
      <div className="flex items-start gap-2.5">
        <span className="mt-[1px] w-[12px] shrink-0 text-center text-[12px] font-bold" style={{ color }}>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] leading-snug text-ink">{text}</div>
          {a.routeReason && <div className="mt-0.5 text-[12px] text-muted">Why this agent: {lowerFirst(a.routeReason)}</div>}
          {(kind || a.injectedFault || a.costCents) && (
            <div className="mt-0.5 text-[12px] text-muted">
              {[kind, a.costCents ? `Cost ${fmtCents(a.costCents)}` : null, a.injectedFault && (a.faultSource === "chaos" ? "Broken by chaos mode" : "Injected by you")]
                .filter(Boolean)
                .join(" · ")}
            </div>
          )}
          {a.translation && a.translation.method !== "native" && (
            <div className="mt-0.5 text-[12px] text-muted" title={a.translation.text}>
              {a.translation.method === "llm" ? "Answer read by GPT" : "Answer read from the agent's own format"} ({a.translation.kept} finding
              {a.translation.kept === 1 ? "" : "s"})
            </div>
          )}
          {a.verification && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {a.verification.layers.map((l) => (
                <span
                  key={l.layer}
                  title={l.reason}
                  className="rounded-full px-2 py-[1px] text-[11px]"
                  style={{
                    color: l.skipped ? "var(--faint)" : l.pass ? "var(--s-passed)" : "var(--s-failed)",
                    background: l.skipped ? "var(--panel-2)" : l.pass ? "color-mix(in srgb, var(--s-passed) 10%, transparent)" : "color-mix(in srgb, var(--s-failed) 10%, transparent)",
                  }}
                >
                  {l.skipped ? "–" : l.pass ? "✓" : "✕"} {LAYER_NAME[l.layer] ?? l.name}
                </span>
              ))}
            </div>
          )}
          {(a.failureDetail || a.instruction || a.rawOutput !== null) && (
            <div className="mt-1.5">
              <Details>
                <AttemptDetails a={a} />
              </Details>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function AttemptDetails({ a }: { a: AttemptView }) {
  return (
    <div className="flex flex-col gap-2 rounded-[8px] bg-panel-2 p-3 text-[12px] text-ink-2">
      {a.failureDetail && <div>{a.failureDetail}</div>}
      {a.translation && (
        <div>
          <span className="font-medium text-ink">Translation:</span> {a.translation.text}
        </div>
      )}
      {a.verification?.layers.map((l) => (
        <div key={l.layer}>
          <span className="font-medium text-ink">{LAYER_NAME[l.layer] ?? l.name}:</span> {l.reason}
          {l.source === "llm" && <span className="text-muted"> (gpt-5.6-luna)</span>}
        </div>
      ))}
      <div className="text-muted">
        Took {fmtMs(a.latencyMs)}
        {a.transportRetries > 0 && ` · reconnected ${a.transportRetries}× with the same request key`}
      </div>
      <div className="text-muted">Request key {a.idempotencyKey}</div>
      {a.instruction && <Code label="Instruction sent">{a.instruction}</Code>}
      {a.rawOutput !== null && a.rawOutput !== undefined && <Code label="Raw output">{JSON.stringify(a.rawOutput, null, 2)}</Code>}
    </div>
  );
}

function Code({ label, children }: { label: string; children: string }) {
  const text = children.length > 5000 ? `${children.slice(0, 5000)}\n…` : children;
  return (
    <div>
      <div className="mb-1 text-muted">{label}</div>
      <pre className="max-h-[200px] overflow-auto whitespace-pre-wrap break-words rounded-[6px] border border-line bg-panel p-2 font-mono text-[11px] leading-relaxed text-ink-2">
        {text}
      </pre>
    </div>
  );
}

// ---------- output ----------

function Output({ node }: { node: NodeView }) {
  const { state } = useAxolotl();
  const [output, setOutput] = useState<unknown>(undefined);
  const runId = state.runId;
  useEffect(() => {
    let cancelled = false;
    if (!runId) return;
    api
      .node(runId, node.id)
      .then((d) => !cancelled && setOutput(d.node.output ?? null))
      .catch(() => !cancelled && setOutput(null));
    return () => {
      cancelled = true;
    };
  }, [runId, node.id, node.state]);

  if (output === undefined) return <Skeleton lines={3} />;
  if (output === null) return <div className="text-[13px] text-muted">No output stored.</div>;
  const o = output as Record<string, unknown>;
  if (Array.isArray(o.pages)) {
    const pages = (o as unknown as CrawlOutput).pages;
    return (
      <div className="text-[13px] text-ink-2">
        Found {pages.length} pages: {pages.map((p) => shortPath(p.url)).join(", ")}
      </div>
    );
  }
  if (node.builtin === "merge") {
    const m = o as unknown as MergeOutput;
    return (
      <div className="text-[13px] leading-relaxed text-ink-2">
        Combined {m.issues.length} findings from {m.coverage.filter((c) => c.passed).length} of {m.coverage.length} checks.
        {m.partialBranches.length > 0 && <span className="text-[var(--s-partial)]"> Missing: {m.partialBranches.map((p) => p.label).join(", ")}.</span>}
      </div>
    );
  }
  if (node.builtin === "prioritize") {
    const p = o as unknown as PrioritizedOutput;
    return <IssueList issues={p.issues} lead={`${p.issues.length} unique problems (merged from ${p.dedupedFrom} findings). Most urgent first:`} />;
  }
  if (node.builtin === "fixplan") {
    const f = o as unknown as FixPlanOutput;
    return (
      <div>
        <div className="text-[14px] font-semibold text-ink">{f.headline}</div>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{f.summary}</p>
        <div className="mt-3">
          <Details summary={`Show ${f.topFixes.length} drafted fixes`}>
            <div className="flex flex-col gap-3">
              {f.topFixes.map((fx) => (
                <div key={fx.issueId}>
                  <div className="mb-1 text-[12.5px] font-medium text-ink">{fx.title}</div>
                  <Code label={fx.language}>{fx.patch}</Code>
                </div>
              ))}
            </div>
          </Details>
        </div>
      </div>
    );
  }
  if (Array.isArray(o.issues)) {
    const issues = (o as unknown as AuditOutput).issues;
    return <IssueList issues={issues} lead={issues.length ? `Found ${issues.length} problem${issues.length === 1 ? "" : "s"}:` : "No problems found."} />;
  }
  return <Code label="Output">{JSON.stringify(output, null, 2)}</Code>;
}

function IssueList({ issues, lead }: { issues: AuditOutput["issues"]; lead: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? issues : issues.slice(0, 5);
  return (
    <div>
      <div className="mb-2 text-[13px] text-ink-2">{lead}</div>
      <ul className="flex flex-col gap-2">
        {shown.map((i, idx) => (
          <li key={`${i.rule}-${i.pageUrl}-${i.selector ?? ""}-${idx}`} className="flex gap-2 text-[13px] leading-snug">
            <span className="mt-[6px] inline-block h-[7px] w-[7px] shrink-0 rounded-full" style={{ background: SEVERITY_COLOR[i.severity] }} title={i.severity} />
            <span className="text-ink">
              {issueText(i.description)}
              <span className="text-muted"> · {shortPath(i.pageUrl)}</span>
            </span>
          </li>
        ))}
      </ul>
      {issues.length > 5 && (
        <button className="mt-2 text-[12.5px] text-muted hover:text-ink hover:underline" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${issues.length}`}
        </button>
      )}
    </div>
  );
}

// ---------- agents found ----------

/** What the router found for this step at run time: the try order, and what it left out and why. */
function AgentsFound({ node }: { node: NodeView }) {
  const { state } = useAxolotl();
  const [stats, setStats] = useState<AgentStats[] | null>(null);
  useEffect(() => {
    api.stats().then((s) => setStats(s.stats)).catch(() => setStats([]));
  }, [state.statsVersion]);
  const route = node.route;
  if (!route) return <div className="text-[13px] text-muted">Axolotl searches for agents when this step starts.</div>;
  return (
    <div className="flex flex-col gap-3">
      {route.searched.length > 0 && <div className="text-[12px] text-muted">Searched {route.searched.join(" and ")}. Tried in this order:</div>}
      {route.agents.length === 0 ? (
        <div className="text-[13px] text-muted">No usable agent found.</div>
      ) : (
        <ol className="flex flex-col gap-2.5">
          {route.agents.map((c, i) => {
            const s = stats?.find((x) => x.agentId === c.agent.agentId && x.capability === node.capability);
            const score = s?.score ?? 0.5;
            const current = node.currentAgent?.agentId === c.agent.agentId;
            const verdict = c.verdict ? VERDICT[c.verdict] : null;
            return (
              <li key={c.agent.agentId} className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 gap-2">
                  <span className="mt-[1px] w-[14px] shrink-0 text-right text-[12px] tabular text-faint">{i + 1}</span>
                  <div className="min-w-0">
                    <div className="truncate text-[13px] text-ink" style={current ? { fontWeight: 600 } : undefined} title={c.agent.provider}>
                      {c.agent.name}
                    </div>
                    <div className="text-[12px] text-muted">
                      <span style={c.tier === "paid" ? { color: "var(--ink-2)" } : undefined}>{tierLabel(c.tier, c.priceCents)}</span>
                      {verdict && (
                        <span title={`${verdict.title}${c.trustScore !== undefined ? `. Trust score ${c.trustScore} of 100.` : ""}`}>
                          {" · "}
                          <span style={{ color: verdict.color }}>{verdict.label}</span>
                          {c.trustScore !== undefined && <span className="tabular"> {c.trustScore}</span>}
                        </span>
                      )}
                      {current && " · in use"}
                    </div>
                    <div className="mt-0.5 text-[12px] leading-snug text-faint">{c.reason}</div>
                  </div>
                </div>
                {stats === null ? (
                  <span className="mt-1 h-[6px] w-[64px] shrink-0 animate-pulse rounded-full bg-panel-2" />
                ) : (
                  <div className="mt-0.5 flex shrink-0 items-center gap-2" title={`Passed Axolotl's checks ${Math.round(score * 100)}% of the time (${s?.attempts ?? 0} attempts)`}>
                    <Meter value={score} width={48} color={!s?.attempts ? "var(--faint)" : score >= 0.8 ? "var(--s-passed)" : score >= 0.55 ? "var(--ink-2)" : "var(--s-failed)"} />
                    <span className="w-[30px] text-right text-[12px] tabular text-muted">{Math.round(score * 100)}%</span>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {route.notes.length > 0 && (
        <ul className="flex flex-col gap-1 text-[12px] leading-snug text-[var(--s-verifying)]">
          {route.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      {route.skipped.length > 0 && (
        <Details summary={`Left out (${route.skipped.length})`}>
          <ul className="flex flex-col gap-2 rounded-[8px] bg-panel-2 p-3">
            {route.skipped.map((sk, i) => (
              <li key={`${sk.agent.agentId}-${i}`} className="text-[12.5px] leading-snug">
                <div className="text-ink-2">{sk.agent.name}</div>
                <div className="text-muted">{sk.reason}</div>
              </li>
            ))}
          </ul>
        </Details>
      )}
    </div>
  );
}

function Skeleton({ lines }: { lines: number }) {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="h-[10px] animate-pulse rounded bg-panel-2" style={{ width: `${90 - i * 18}%` }} />
      ))}
    </div>
  );
}
