"use client";
import { useState } from "react";
import { Segmented } from "@/components/ui/primitives";
import type { PrioritizedIssue } from "@/lib/types";
import { overlayPages, overlaySrc } from "@/components/report/format";

const MAX_SEGMENTS = 6;

export function IssueOverlay({
  runId,
  siteUrl,
  issues,
  page,
  onPage,
}: {
  runId: string;
  siteUrl: string;
  issues: PrioritizedIssue[];
  page: string | null;
  onPage: (url: string) => void;
}) {
  const pages = overlayPages(siteUrl, issues);
  const current = pages.find((p) => p.url === page) ?? pages[0];
  const src = overlaySrc(runId, current.url);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const loading = loadedSrc !== src;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {pages.length <= MAX_SEGMENTS ? (
          <Segmented<string>
            value={current.url}
            onChange={onPage}
            options={pages.map((p) => ({
              value: p.url,
              label: (
                <>
                  {p.label}
                  <span className={`ml-1.5 tabular ${p.count ? "text-muted" : "text-faint"}`}>{p.count}</span>
                </>
              ),
            }))}
          />
        ) : (
          <select
            value={current.url}
            onChange={(e) => onPage(e.target.value)}
            aria-label="Page"
            className="h-9 rounded-[8px] border border-line-strong bg-panel px-2.5 text-[13.5px] text-ink outline-none focus:border-[var(--focus)]"
          >
            {pages.map((p) => (
              <option key={p.url} value={p.url}>
                {p.label} ({p.count})
              </option>
            ))}
          </select>
        )}
        <span className="text-[13px] text-muted max-lg:hidden">The real page, with each problem outlined in place.</span>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex h-8 items-center rounded-[8px] border border-line-strong bg-panel px-3 text-[12.5px] font-medium text-ink transition-colors hover:bg-panel-2"
        >
          Open in a new tab
        </a>
      </div>
      {/* Its own scroll area at a fixed height: wheel over the frame scrolls the page inside it. */}
      <div className="card relative mt-3 min-h-[320px] flex-1 overflow-hidden">
        <iframe
          key={src}
          src={src}
          title={`${current.label} with flagged elements outlined`}
          // Same-origin is needed for the frame to load in the in-app preview; the sandbox still blocks
          // forms, popups and top-level navigation from the audited page.
          sandbox="allow-scripts allow-same-origin"
          onLoad={() => setLoadedSrc(src)}
          className="absolute inset-0 h-full w-full border-0"
        />
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-panel text-[13px] text-muted">
            Loading {current.label}…
            <span className="scanbar" style={{ ["--state" as string]: "var(--s-running)" }} />
          </div>
        )}
      </div>
    </div>
  );
}
