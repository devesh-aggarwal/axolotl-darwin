// Input adapter: turns a node's input into what a specific agent needs. Always produces a
// precise natural-language instruction; when the agent exposes an argument schema it also
// maps the input onto that schema (one LLM call per agent+template in live mode, cached).
import crypto from "node:crypto";
import type { NodeTemplate } from "@/config/workflow";
import { DEFAULTS } from "@/config/workflow";
import { getDb } from "@/lib/db";
import { callLlmJson, LlmUnavailableError, sanitizeSecrets, type LlmUnavailableReason, type RunLlmBudget } from "@/lib/llm/gateway";
import { stripQueries } from "@/lib/audit/url";
import { rulesForCategory } from "@/lib/audit/rules";
import { ADAPTER_PROMPT } from "@/lib/llm/rubric";
import type { AgentNodeInput, AgentRef, AuditCategory } from "@/lib/types";

export interface AdaptedInput {
  instruction: string;
  arguments?: Record<string, unknown>;
  method: "template" | "llm" | "cache";
}

export type ArgSource = "siteUrl" | "pageUrl" | "pages" | "maxPages" | "instruction" | "const";
export type ArgMapping = Record<string, { from: ArgSource; value?: unknown }>;

export interface AdaptInputArgs {
  agent: AgentRef & { argumentSchema?: Record<string, unknown> | null };
  template: NodeTemplate;
  input: AgentNodeInput;
  llmMode: "mock" | "live";
  budget?: RunLlmBudget;
  /** A backup taking over: what the previous agent did wrong, so it isn't repeated. */
  handoff?: Handoff;
}

export interface Handoff {
  /** Agents that already failed this step, in order. */
  failed: { name: string; reason: string }[];
}

const MAX_HANDOFF_REASON = 300;

/**
 * The task, plus what earlier agents got wrong on it. Reasons are Axolotl's failure summaries; they
 * can quote a provider's error text, so they're clipped and stripped of secrets and query strings.
 */
export function withHandoff(instruction: string, handoff: Handoff | undefined): string {
  if (!handoff?.failed.length) return instruction;
  const lines = handoff.failed
    .slice(-3)
    .map((f) => `- ${f.name}: ${clip(stripQueries(sanitizeSecrets(f.reason)).replace(/\s+/g, " "), MAX_HANDOFF_REASON)}`);
  return [
    instruction,
    `Context: you are taking over this task. ${handoff.failed.length === 1 ? "An earlier agent" : "Earlier agents"} failed it:\n${lines.join("\n")}\nAvoid the same problem. Report only what you verify on the live site.`,
  ].join("\n\n");
}

const ARG_SOURCES: ArgSource[] = ["siteUrl", "pageUrl", "pages", "maxPages", "instruction", "const"];
const MAX_PAGES_LISTED = 25;
const MAX_SCHEMA_PROPS = 50;
/** After a mapping request that was sent and failed, later attempts use the heuristic for this long. */
const FAILED_MAPPING_COOLDOWN_MS = 10 * 60_000;
/** Failures where no request was sent (caps, kill switch): the next run may try again. */
const NOT_SENT: ReadonlySet<LlmUnavailableReason> = new Set(["disabled", "no_key", "budget_process", "budget_day", "budget_run"]);

type JsonSchema = Record<string, unknown>;

interface SchemaInfo {
  props: Record<string, JsonSchema>;
  required: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------- template instruction ----------

function auditShape(category: AuditCategory, pagesChecked: string): string {
  return JSON.stringify({
    issues: [
      {
        category,
        severity: "critical|high|medium|low",
        rule: "<rule code from the list below>",
        pageUrl: "<absolute URL of the page the issue is on>",
        selector: "<CSS selector of the element (optional)>",
        description: "<what is wrong, naming the element, file or header>",
        recommendation: "<the concrete change that fixes it>",
        evidence: "<what you observed: attribute, colors, header, status code or byte size>",
      },
    ],
    pagesChecked: [pagesChecked],
    summary: "<one or two sentences>",
  });
}

function categoryHints(category: AuditCategory): string[] {
  switch (category) {
    case "accessibility":
      return ["color-contrast: compute the ratio from the text color and its background; report only below 4.5:1 and put both colors in evidence."];
    case "performance":
      return [
        "oversized-image: images over 500 KB; evidence must contain the image URL and its byte size.",
        "render-blocking-script: synchronous <script src> in <head> without defer/async.",
      ];
    case "seo":
      return ["robots-txt and sitemap are site-wide: use the site root URL as pageUrl."];
    case "security":
      return [
        "Check response headers on the site root response; missing-header issues use the site root URL as pageUrl and name the header in evidence.",
        "insecure-form-action: a <form> whose action posts to http://; evidence contains the action URL.",
      ];
    case "links":
      return [
        'broken-link: selector is a[href="<href exactly as written>"]; evidence contains the resolved absolute URL and the HTTP status or DNS error.',
        "Report only links that return 4xx/5xx or do not resolve; pageUrl is the page containing the link.",
      ];
  }
}

function crawlInstruction(template: NodeTemplate, siteUrl: string, maxPages: number): string {
  const shape = JSON.stringify({ pages: [{ url: "<absolute URL>", title: "<text of the page's <title>, or empty string>", status: 200 }] });
  return [
    `Task: ${template.label}. ${template.description}`,
    `Start at ${siteUrl} and follow same-origin <a href> links breadth-first. Return at most ${maxPages} pages, home page first, as absolute URLs without #fragments or query strings. Include only pages that responded with HTTP 200.`,
    `Output contract: return a single JSON object with exactly this shape:\n${shape}`,
    "Return JSON only: no prose, no Markdown fences.",
  ].join("\n\n");
}

function auditInstruction(template: NodeTemplate, category: AuditCategory, input: AgentNodeInput): string {
  const siteUrl = input.siteUrl;
  const pageUrl = "pageUrl" in input ? input.pageUrl : null;
  const pages = "pages" in input ? input.pages : [];
  const scopeLine = pageUrl
    ? `Audit exactly one page: ${pageUrl} (site root: ${siteUrl}). Report only ${category} issues you observed on that page.`
    : `Audit the site ${siteUrl} for ${category} issues. Pages in scope (${pages.length}): ${pages.slice(0, MAX_PAGES_LISTED).join(", ")}${
        pages.length > MAX_PAGES_LISTED ? ", …" : ""
      }`;
  const rules = rulesForCategory(category)
    .map((r) => `${r.rule} (${r.title}; default severity ${r.severity}; ${r.scope === "site" ? "site-wide" : "per page"})`)
    .join("; ");
  const checked = pageUrl ?? "<every page you checked>";
  return [
    `Task: ${template.label}. ${template.description}`,
    scopeLine,
    `Output contract: return a single JSON object with exactly this shape:\n${auditShape(category, checked)}`,
    [
      "Rules:",
      `- category must be "${category}" for every issue.`,
      `- rule must be one of: ${rules}.`,
      `- pageUrl must be an absolute http(s) URL of a page in scope; site-wide issues use the site root ${siteUrl}.`,
      pageUrl ? `- pagesChecked must include ${pageUrl}.` : "- pagesChecked lists the absolute URLs of every page you checked.",
      ...categoryHints(category).map((h) => `- ${h}`),
      "- Every issue needs concrete evidence. Do not report issues you did not verify and do not pad the report; if there are none, return \"issues\": [].",
    ].join("\n"),
    "Return JSON only: no prose, no Markdown fences.",
  ].join("\n\n");
}

/** Precise natural-language instruction built from the node template, its input and its output contract. */
export function buildInstruction(template: NodeTemplate, input: AgentNodeInput): string {
  if (template.capability === "crawl" || template.contract === "crawl") {
    const maxPages = "maxPages" in input ? input.maxPages : DEFAULTS.maxPages;
    return crawlInstruction(template, input.siteUrl, maxPages);
  }
  const category = template.category ?? (template.capability as AuditCategory | undefined);
  if (category) return auditInstruction(template, category, input);
  return [`Task: ${template.label}. ${template.description}`, `Input: ${JSON.stringify(input)}`, "Return JSON only."].join("\n\n");
}

// ---------- argument schema helpers ----------

function schemaInfo(schema: Record<string, unknown> | null | undefined): SchemaInfo | null {
  if (!isRecord(schema)) return null;
  const root = isRecord(schema.properties) ? schema : isRecord(schema.inputSchema) ? schema.inputSchema : null;
  if (!root || !isRecord(root.properties)) return null;
  const props: Record<string, JsonSchema> = {};
  for (const [k, v] of Object.entries(root.properties).slice(0, MAX_SCHEMA_PROPS)) props[k] = isRecord(v) ? v : {};
  if (!Object.keys(props).length) return null;
  const required = Array.isArray(root.required) ? root.required.filter((r): r is string => typeof r === "string" && r in props) : [];
  return { props, required };
}

function propType(prop: JsonSchema): string | undefined {
  const t = prop.type;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.find((x): x is string => typeof x === "string" && x !== "null");
  return undefined;
}

function hashSchema(info: SchemaInfo): string {
  return crypto.createHash("sha256").update(JSON.stringify(info)).digest("hex").slice(0, 16);
}

/** Deterministic mapping by property names (mock mode, and the fallback in live mode). */
export function heuristicMapping(schema: Record<string, unknown> | null | undefined, input: AgentNodeInput): ArgMapping {
  const info = schemaInfo(schema);
  if (!info) return {};
  const mapping: ArgMapping = {};
  const urlSource: ArgSource = "pageUrl" in input ? "pageUrl" : "siteUrl";
  for (const [name, prop] of Object.entries(info.props)) {
    const n = name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const type = propType(prop);
    if (/(max|limit)/.test(n) && (/(page|result|url|link|item)/.test(n) || /^(max|limit)$/.test(n))) {
      mapping[name] = { from: "maxPages" };
    } else if (/(^|_)(pages|urls|links|page_list|url_list)$/.test(n) || (type === "array" && /(url|page|link)/.test(n))) {
      mapping[name] = { from: "pages" };
    } else if (/(url|uri|site|domain|host|website|homepage|address|target)/.test(n)) {
      mapping[name] = { from: urlSource };
    } else if (/(query|task|prompt|instruction|message|request|question|goal|input|text)/.test(n)) {
      mapping[name] = { from: "instruction" };
    } else if (info.required.includes(name) && (type === "string" || type === undefined)) {
      mapping[name] = { from: "instruction" };
    }
  }
  return mapping;
}

function sourceValue(m: { from: ArgSource; value?: unknown }, input: AgentNodeInput, instruction: string): unknown {
  switch (m.from) {
    case "siteUrl":
      return input.siteUrl;
    case "pageUrl":
      return "pageUrl" in input ? input.pageUrl : input.siteUrl;
    case "pages":
      return "pages" in input ? input.pages : ["pageUrl" in input ? input.pageUrl : input.siteUrl];
    case "maxPages":
      return "maxPages" in input ? input.maxPages : "pages" in input ? input.pages.length : DEFAULTS.maxPages;
    case "instruction":
      return instruction;
    case "const":
      return m.value;
  }
}

function toHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function coerce(name: string, prop: JsonSchema, raw: unknown): unknown {
  let value = raw;
  if (typeof value === "string" && /(domain|host)/i.test(name)) value = toHost(value);
  switch (propType(prop)) {
    case "string":
      return Array.isArray(value) ? value.join("\n") : value === undefined || value === null ? undefined : String(value);
    case "integer":
    case "number": {
      let n = Number(Array.isArray(value) ? value.length : value);
      if (!Number.isFinite(n)) return undefined;
      if (propType(prop) === "integer") n = Math.round(n);
      if (typeof prop.minimum === "number") n = Math.max(prop.minimum, n);
      if (typeof prop.maximum === "number") n = Math.min(prop.maximum, n);
      return n;
    }
    case "array":
      return Array.isArray(value) ? value : value === undefined ? undefined : [value];
    case "boolean":
      return typeof value === "boolean" ? value : value === "true";
    default:
      return value;
  }
}

/** Builds the agent's arguments from a validated mapping. */
export function applyMapping(
  mapping: ArgMapping,
  schema: Record<string, unknown> | null | undefined,
  input: AgentNodeInput,
  instruction: string,
): Record<string, unknown> {
  const info = schemaInfo(schema);
  const args: Record<string, unknown> = {};
  for (const [name, m] of Object.entries(mapping)) {
    const prop = info?.props[name];
    if (!prop) continue;
    const v = coerce(name, prop, sourceValue(m, input, instruction));
    if (v !== undefined) args[name] = v;
  }
  return args;
}

/** Valid when every arg exists in the schema, every source is known and const entries carry a value. */
export function validateMapping(mapping: unknown, schema: Record<string, unknown> | null | undefined): mapping is ArgMapping {
  const info = schemaInfo(schema);
  if (!info || !isRecord(mapping)) return false;
  for (const [name, m] of Object.entries(mapping)) {
    if (!(name in info.props) || !isRecord(m)) return false;
    if (!ARG_SOURCES.includes(m.from as ArgSource)) return false;
    if (m.from === "const" && (m.value === undefined || m.value === null)) return false;
  }
  return true;
}

// ---------- LLM mapping + cache ----------

interface CachedMapping {
  schemaHash: string;
  mapping: ArgMapping;
}

function readMappingCache(agentId: string, templateId: string, schemaHash: string): ArgMapping | null {
  try {
    const row = getDb()
      .prepare("SELECT mapping_json FROM adapter_cache WHERE agent_id = ? AND template_id = ?")
      .get(agentId, templateId) as { mapping_json: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.mapping_json) as CachedMapping;
    return parsed?.schemaHash === schemaHash ? parsed.mapping : null;
  } catch {
    return null;
  }
}

function writeMappingCache(agentId: string, templateId: string, entry: CachedMapping): void {
  try {
    getDb()
      .prepare("INSERT OR REPLACE INTO adapter_cache (agent_id, template_id, mapping_json, created_at) VALUES (?, ?, ?, ?)")
      .run(agentId, templateId, JSON.stringify(entry), Date.now());
  } catch {
    // Without the cache the next attempt simply asks again (still budget-guarded).
  }
}

function mappingSchema(propNames: string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      mappings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            arg: { type: "string", enum: propNames },
            from: { type: "string", enum: ARG_SOURCES },
            value: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }] },
          },
          required: ["arg", "from", "value"],
          additionalProperties: false,
        },
      },
    },
    required: ["mappings"],
    additionalProperties: false,
  };
}

function toMapping(data: unknown): ArgMapping | null {
  if (!isRecord(data) || !Array.isArray(data.mappings)) return null;
  const mapping: ArgMapping = {};
  for (const e of data.mappings) {
    if (!isRecord(e) || typeof e.arg !== "string" || typeof e.from !== "string") return null;
    const value = typeof e.value === "string" ? clip(e.value, 500) : e.value;
    mapping[e.arg] = e.from === "const" ? { from: "const", value } : { from: e.from as ArgSource };
  }
  return mapping;
}

function isValidLlmMapping(data: unknown, info: SchemaInfo): boolean {
  const mapping = toMapping(data);
  return mapping !== null && validateMapping(mapping, { properties: info.props });
}

type LlmMappingResult = { mapping: ArgMapping; cached: boolean } | null;

interface AdapterState {
  /** One mapping request per agent+template+schema at a time; parallel fan-out attempts share it. */
  pending: Map<string, Promise<LlmMappingResult>>;
  failedAt: Map<string, number>;
}

// On globalThis like the gateway's state, so hot reloads keep one copy.
const gs = globalThis as unknown as { __axolotlAdapter?: AdapterState };

function adapterState(): AdapterState {
  if (!gs.__axolotlAdapter) gs.__axolotlAdapter = { pending: new Map(), failedAt: new Map() };
  return gs.__axolotlAdapter;
}

/** Shares an in-flight request and skips keys whose last sent request failed recently. */
function sharedLlmMapping(
  key: string,
  a: AdaptInputArgs,
  info: SchemaInfo,
  instruction: string,
): { result: Promise<LlmMappingResult>; shared: boolean } {
  const st = adapterState();
  const failedAt = st.failedAt.get(key);
  if (failedAt !== undefined && Date.now() - failedAt < FAILED_MAPPING_COOLDOWN_MS) return { result: Promise.resolve(null), shared: true };
  const pending = st.pending.get(key);
  if (pending) return { result: pending, shared: true };
  const result = llmMapping(a, info, instruction).then(
    (r) => {
      st.pending.delete(key);
      if (r.failed === "sent") st.failedAt.set(key, Date.now());
      else if (r.failed === undefined) st.failedAt.delete(key);
      return r.result;
    },
    () => {
      st.pending.delete(key);
      return null;
    },
  );
  st.pending.set(key, result);
  return { result, shared: false };
}

async function llmMapping(
  a: AdaptInputArgs,
  info: SchemaInfo,
  instruction: string,
): Promise<{ result: LlmMappingResult; failed?: "sent" | "not_sent" }> {
  const user = [
    `Node: ${a.template.label} (template "${a.template.id}", capability ${a.template.capability ?? "n/a"})`,
    `Agent: ${a.agent.name} (${a.agent.agentId})`,
    `Node input: ${clip(JSON.stringify(a.input), 1500)}`,
    `Instruction text available as "instruction": ${clip(instruction, 600)}`,
    `Argument schema: ${clip(JSON.stringify({ properties: info.props, required: info.required }), 4000)}`,
  ].join("\n\n");
  try {
    const res = await callLlmJson<unknown>({
      purpose: "adapter",
      system: ADAPTER_PROMPT,
      user,
      schemaName: "argument_mapping",
      schema: mappingSchema(Object.keys(info.props)),
      runBudget: a.budget,
      validate: (d) => isValidLlmMapping(d, info),
    });
    const mapping = toMapping(res.data);
    if (!mapping || !validateMapping(mapping, { properties: info.props })) return { result: null, failed: "sent" };
    return { result: { mapping, cached: res.cached } };
  } catch (err) {
    const notSent = err instanceof LlmUnavailableError && NOT_SENT.has(err.reason);
    return { result: null, failed: notSent ? "not_sent" : "sent" };
  }
}

/** Fills required properties the mapping left out using the name heuristic. */
function withRequired(mapping: ArgMapping, info: SchemaInfo, input: AgentNodeInput): ArgMapping {
  const heuristic = heuristicMapping({ properties: info.props, required: info.required }, input);
  const out = { ...mapping };
  for (const r of info.required) if (!out[r] && heuristic[r]) out[r] = heuristic[r];
  return out;
}

export async function adaptInput(a: AdaptInputArgs): Promise<AdaptedInput> {
  // Argument mapping is keyed on the plain task, so a handoff never costs an extra mapping call.
  const base = buildInstruction(a.template, a.input);
  const instruction = withHandoff(base, a.handoff);
  const info = schemaInfo(a.agent.argumentSchema);
  if (!info) return { instruction, method: "template" };
  const schema = { properties: info.props, required: info.required };

  if (a.llmMode === "live") {
    const schemaHash = hashSchema(info);
    const cached = readMappingCache(a.agent.agentId, a.template.id, schemaHash);
    if (cached && validateMapping(cached, schema)) {
      return { instruction, arguments: applyMapping(withRequired(cached, info, a.input), schema, a.input, instruction), method: "cache" };
    }
    const key = JSON.stringify([a.agent.agentId, a.template.id, schemaHash]);
    const { result, shared } = sharedLlmMapping(key, a, info, base);
    const fromLlm = await result;
    if (fromLlm) {
      // Only the attempt that made the request writes the cache and reports "llm".
      if (!shared) writeMappingCache(a.agent.agentId, a.template.id, { schemaHash, mapping: fromLlm.mapping });
      const args = applyMapping(withRequired(fromLlm.mapping, info, a.input), schema, a.input, instruction);
      return { instruction, arguments: args, method: fromLlm.cached || shared ? "cache" : "llm" };
    }
  }
  const mapping = heuristicMapping(schema, a.input);
  return { instruction, arguments: applyMapping(mapping, schema, a.input, instruction), method: "template" };
}
