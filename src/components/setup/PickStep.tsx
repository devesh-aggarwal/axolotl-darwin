"use client";
import { useState, type CSSProperties, type ReactNode } from "react";
import { api, type SearchResponse } from "@/components/api";
import type { NodeTemplate } from "@/config/workflow";
import { Button } from "@/components/ui/primitives";
import type { AgentCandidate, AgentPool, AgentSource, TrustReport } from "@/lib/types";
import { MAX_BACKUPS, SOURCE_LABEL, approvalFlags, informativeReasons, memberKey, plainDescription, plainNote, readinessView, roleOf, shortDescription, stepName, type Draft } from "./model";
import { PickButton, StatusLabel, StepHeading, TextButton } from "./ui";
import { TrialButton, TrustLine, TrustSignals, TrustVerdictLabel } from "./Trust";
import { useCopy } from "@/components/ui/copy";

export interface SearchState {
  status: "loading" | "done" | "error";
  result?: SearchResponse;
  error?: string;
  at?: number;
}

const SCOPE_LABEL: Record<NodeTemplate["scope"], string> = {
  run: "Runs once per audit",
  site: "Runs once for the whole site",
  page: "Runs once per page",
};

export function PickStep({
  template,
  client,
  actConfigured,
  query,
  onQuery,
  onSearch,
  search,
  draft,
  savedPool,
  onPrimary,
  onBackup,
  onUnassign,
  done,
  active,
}: {
  template: NodeTemplate;
  client: AgentSource;
  actConfigured: boolean;
  query: string;
  onQuery: (q: string) => void;
  onSearch: () => void;
  search: SearchState | undefined;
  draft: Draft;
  savedPool: AgentPool | null;
  onPrimary: (c: AgentCandidate) => void;
  onBackup: (c: AgentCandidate) => void;
  onUnassign: (key: string) => void;
  done: boolean;
  active: boolean;
}) {
  const copy = useCopy();
  const [details, setDetails] = useState(false);
  const loading = search?.status === "loading";
  const result = search?.result;
  const agents = result?.agents ?? [];
  const note = plainNote(result?.note);
  const savedKeys = new Set(savedPool?.members.map(memberKey) ?? []);
  const backupsFull = draft.backups.length >= MAX_BACKUPS;

  return (
    <div className="flex flex-col pb-8">
      <header className="px-6 pb-5 pt-5">
        <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-ink">{stepName(template)}</h2>
        <p className="mt-1 max-w-[640px] text-[13px] leading-relaxed text-muted">
          {template.description} {SCOPE_LABEL[template.scope]}.
        </p>
      </header>

      <div className="px-6">
        <StepHeading
          n={1}
          title="Pick agents"
          done={done}
          active={active}
          hint={copy.pickHint(MAX_BACKUPS)}
        />
        <form
          className="mt-4 flex items-center gap-2 pl-[34px]"
          onSubmit={(e) => {
            e.preventDefault();
            if (!loading && query.trim()) onSearch();
          }}
        >
          <div className="relative min-w-0 flex-1 overflow-hidden rounded-[6px]">
            <input
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              spellCheck={false}
              aria-label="Search query"
              className="h-9 w-full rounded-[6px] border border-line bg-bg px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-faint focus:border-[var(--focus)]"
              placeholder={template.query}
            />
            {loading && <div className="scanbar" style={{ "--state": "var(--s-running)" } as CSSProperties} />}
          </div>
          {template.query && query !== template.query && (
            <TextButton type="button" onClick={() => onQuery(template.query ?? "")} className="px-1">
              Reset
            </TextButton>
          )}
          <Button tone="primary" type="submit" disabled={loading || !query.trim()} className="h-9 px-4">
            {loading ? "Searching…" : "Search"}
          </Button>
        </form>
        <div className="mt-2 pl-[34px] text-[12px] text-faint">
          {client === "darwin" ? "Searches the public Darwin API." : "Searches the built-in mock catalog. Nothing leaves this machine."}
        </div>

        {client === "darwin" && (
          <div className="ml-[34px] mt-4 rounded-[6px] bg-panel px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-2">
            {actConfigured
              ? "Connected to Darwin, so readiness shows what your account can start. Darwin checks again when a run starts."
              : "Darwin only confirms readiness for connected accounts. Until one is connected, results show as unverified and can't start a run."}
          </div>
        )}
      </div>

      <div className="mt-5 px-6">
        {search?.status === "error" && (
          <div className="pl-[34px] text-[13px]">
            <div className="text-[var(--s-failed)]">Search failed</div>
            <div className="mt-1 text-[12.5px] text-muted">{search.error}</div>
          </div>
        )}

        {!result && search?.status !== "error" && (
          <div className="pl-[34px] text-[13px] text-muted">
            {loading ? `Searching ${SOURCE_LABEL[client]}…` : `No search yet. Results from ${SOURCE_LABEL[client]} appear here.`}
          </div>
        )}

        {result && (
          <>
            <div className="flex items-baseline justify-between gap-4 pl-[34px]">
              <div className="text-[13px] text-ink-2">
                {agents.length === 0 ? "No agents found" : `${agents.length} agent${agents.length === 1 ? "" : "s"} found`}
                {result.status === "needs_input" && <span className="text-muted"> · Darwin wants a more specific query</span>}
              </div>
              {agents.length > 0 && (
                <TextButton onClick={() => setDetails((v) => !v)} aria-expanded={details}>
                  {details ? "Hide details" : "Show details"}
                </TextButton>
              )}
            </div>
            {note && (
              <p className="mt-1.5 line-clamp-2 pl-[34px] text-[12.5px] leading-relaxed text-muted" title={note}>
                {note}
              </p>
            )}
            <ul className={`mt-3 flex flex-col gap-1 pl-[22px] ${loading ? "opacity-50" : ""}`}>
              {agents.map((c, i) => (
                <CandidateRow
                  key={`${result.searchId}:${memberKey(c)}`}
                  templateId={template.id}
                  c={c}
                  index={i}
                  draft={draft}
                  saved={savedKeys.has(memberKey(c))}
                  details={details}
                  backupsFull={backupsFull}
                  onPrimary={onPrimary}
                  onBackup={onBackup}
                  onUnassign={onUnassign}
                />
              ))}
            </ul>
          </>
        )}

        {client === "darwin" && (
          <DirectAdder
            template={template}
            draft={draft}
            savedKeys={savedKeys}
            backupsFull={backupsFull}
            onPrimary={onPrimary}
            onBackup={onBackup}
            onUnassign={onUnassign}
          />
        )}
      </div>
    </div>
  );
}

type RowActions = {
  draft: Draft;
  backupsFull: boolean;
  onPrimary: (c: AgentCandidate) => void;
  onBackup: (c: AgentCandidate) => void;
  onUnassign: (key: string) => void;
};

function CandidateRow({ templateId, c: found, index, saved, details, draft, backupsFull, onPrimary, onBackup, onUnassign }: RowActions & {
  templateId: string;
  c: AgentCandidate;
  index: number;
  saved: boolean;
  details: boolean;
}) {
  const copy = useCopy();
  // A trial updates the trust report in place.
  const [trust, setTrust] = useState<TrustReport | undefined>(found.trust);
  const c: AgentCandidate = trust ? { ...found, trust } : found;
  const unsafe = trust?.verdict === "avoid";
  const key = memberKey(c);
  const role = roleOf(draft, key);
  const r = readinessView(c.readiness, c.source);
  const blurb = shortDescription(c.description) || informativeReasons(c)[0] || "";
  const flags = c.source === "darwin" ? approvalFlags(c) : [];
  return (
    <li
      className={`anim-rise rounded-[6px] px-3 py-3 transition-colors ${role ? "bg-panel" : "hover:bg-raised"}`}
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-[200px] flex-1">
          <div className="text-[13.5px] font-medium leading-snug text-ink">{c.name}</div>
          <div className="mt-0.5 text-[12px] text-muted">
            {c.provider ?? SOURCE_LABEL[c.source]}
            {c.source === "darwin" && c.endpoint && (
              <span title="Darwin published a verified address for this agent, so it can run without Darwin Act"> · can run directly</span>
            )}
            {flags.length > 0 && (
              <span className="text-[var(--s-verifying)]" title="Unattended runs can't stop for these, so prefer agents without them">
                {" "}
                · needs {flags.join(" and ")}
              </span>
            )}
            {saved && <span className="text-faint"> · already saved</span>}
          </div>
        </div>
        {trust && (
          <div className="w-[112px] shrink-0">
            <TrustVerdictLabel trust={trust} />
          </div>
        )}
        <div className="w-[92px] shrink-0">
          <StatusLabel color={r.color} label={r.label} title={r.title} />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <PickButton
            active={role?.role === "primary"}
            strong
            disabled={unsafe && role?.role !== "primary"}
            onClick={() => (role?.role === "primary" ? onUnassign(key) : onPrimary(c))}
            aria-label={`${copy.primary}: ${c.name}`}
            title={unsafe && role?.role !== "primary" ? "Failed its safety check, so it can't be used" : role?.role === "primary" ? `Remove as ${copy.primary.toLowerCase()}` : `Use as ${copy.primary === "Primary" ? "the primary agent" : copy.primary.toLowerCase()}`}
          >
            {copy.primary}
          </PickButton>
          <PickButton
            active={role?.role === "backup"}
            disabled={(backupsFull || unsafe) && role?.role !== "backup"}
            onClick={() => (role?.role === "backup" ? onUnassign(key) : onBackup(c))}
            aria-label={`${role?.role === "backup" ? `Backup ${role.index + 1}` : "Backup"}: ${c.name}`}
            title={role?.role === "backup" ? "Remove as backup" : unsafe ? "Failed its safety check, so it can't be used" : backupsFull ? `Already ${MAX_BACKUPS} backups; remove one first` : "Add as a backup"}
            className="w-[76px]"
          >
            {role?.role === "backup" ? `Backup ${role.index + 1}` : "Backup"}
          </PickButton>
        </div>
      </div>
      {blurb && (
        <p className="mt-1.5 line-clamp-2 max-w-[640px] text-[12.5px] leading-relaxed text-muted" title={plainDescription(c.description)}>
          {blurb}
        </p>
      )}
      {trust && (
        <div className="flex flex-wrap items-center gap-x-4">
          <TrustLine trust={trust} />
          <div className="mt-1.5">
            <TrialButton templateId={templateId} agentId={c.agentId} trust={trust} onTrust={setTrust} />
          </div>
        </div>
      )}
      {details && <CandidateDetails c={c} />}
    </li>
  );
}

/**
 * Add an agent by its own MCP address: a provider's documented endpoint, or Axolotl's local test
 * agent for this step. Direct agents run without Darwin Act.
 */
function DirectAdder({ template, savedKeys, ...actions }: RowActions & { template: NodeTemplate; savedKeys: Set<string> }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<AgentCandidate[]>([]);
  const [testAgent, setTestAgent] = useState<{ name: string; url: string } | null>(null);
  // An agent with several tools, none clearly for this step: the user picks one.
  const [choice, setChoice] = useState<{ url: string; tools: { name: string; description: string }[] } | null>(null);

  const expand = () => {
    setOpen(true);
    api
      .directInfo(template.id)
      .then((r) => setTestAgent(r.testAgent))
      .catch(() => setTestAgent(null));
  };

  const connect = async (address: string, toolName?: string) => {
    if (!address.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.connectDirect(template.id, address.trim(), toolName);
      if (!res.candidate) {
        if (res.tools.length) setChoice({ url: address.trim(), tools: res.tools });
        else setError(res.note ?? "No tool on that address fits this step.");
        return;
      }
      setChoice(null);
      const c = res.candidate;
      setFound((list) => [c, ...list.filter((x) => memberKey(x) !== memberKey(c))].slice(0, 4));
      setUrl("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="mt-6 pl-[34px]">
        <TextButton onClick={expand}>Add an agent by its address</TextButton>
      </div>
    );
  }

  return (
    <div className="mt-6 pl-[34px]">
      <div className="text-[13px] font-medium text-ink">Add an agent by its address</div>
      <p className="mt-1 max-w-[600px] text-[12.5px] leading-relaxed text-muted">
        Paste an agent&rsquo;s MCP address to run it directly, without Darwin Act. Axolotl connects once to check it answers.
      </p>
      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void connect(url);
        }}
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          spellCheck={false}
          aria-label="Agent MCP address"
          placeholder="https://agent.example.com/mcp"
          className="h-9 min-w-0 flex-1 rounded-[6px] border border-line bg-bg px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-faint focus:border-[var(--focus)]"
        />
        <Button type="submit" disabled={busy || !url.trim()} className="h-9 px-4">
          {busy ? "Connecting…" : "Connect"}
        </Button>
      </form>
      {testAgent && (
        <div className="mt-2 text-[12px] text-faint">
          No address handy?{" "}
          <TextButton type="button" onClick={() => void connect(testAgent.url)} disabled={busy}>
            Use the local test agent ({testAgent.name})
          </TextButton>
        </div>
      )}
      {error && <div className="mt-2 text-[12.5px] text-[var(--s-failed)]">{error}</div>}
      {choice && (
        <div className="mt-3">
          <div className="text-[12.5px] text-muted">This agent offers several tools. Which one does this step?</div>
          <ul className="mt-1.5 flex flex-col gap-1">
            {choice.tools.slice(0, 12).map((t) => (
              <li key={t.name}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void connect(choice.url, t.name)}
                  className="w-full rounded-[6px] px-2.5 py-1.5 text-left transition-colors hover:bg-raised disabled:opacity-50"
                >
                  <span className="text-[13px] font-medium text-ink">{t.name}</span>
                  {t.description && <span className="ml-2 line-clamp-1 text-[12px] text-muted">{t.description}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {found.length > 0 && (
        <ul className="-ml-3 mt-3 flex flex-col gap-1">
          {found.map((c, i) => (
            <CandidateRow key={memberKey(c)} templateId={template.id} c={c} index={i} saved={savedKeys.has(memberKey(c))} details={false} {...actions} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CandidateDetails({ c }: { c: AgentCandidate }) {
  const blurb = shortDescription(c.description);
  // The card shows the first sentence; the rest of the description (if any) lives here.
  const more = plainDescription(c.description).slice(blurb.length).trim();
  // Without a description the card already shows the first reason.
  const reasons = blurb ? informativeReasons(c) : informativeReasons(c).slice(1);
  const rows: [string, ReactNode][] = [];
  if (more) rows.push(["More", more]);
  if (c.trust) rows.push([`Trust check (${c.trust.score})`, <TrustSignals key="t" trust={c.trust} />]);
  rows.push(["Can start a run", c.canStartThread ? "Yes" : "No"]);
  if (c.providerCheck) rows.push(["Provider check", c.providerCheck.replace(/_/g, " ")]);
  if (reasons.length) rows.push(["Why it matched", reasons.join(" ")]);
  if (c.uncertainties.length)
    rows.push([
      "Caveats",
      <ul key="u" className="flex flex-col gap-0.5">
        {c.uncertainties.map((u) => (
          <li key={u}>{u}</li>
        ))}
      </ul>,
    ]);
  rows.push(["Agent ID", <span key="a" className="break-all text-faint">{c.agentId}</span>]);
  rows.push(["Capability ID", <span key="c" className="break-all text-faint">{c.capabilityId}</span>]);

  return (
    <dl className="mt-3 grid grid-cols-[128px_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[12px] leading-relaxed">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-faint">{k}</dt>
          <dd className="text-muted">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
