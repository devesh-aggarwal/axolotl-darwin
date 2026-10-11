"use client";
import type { AgentSource } from "@/lib/types";
import { MAX_BACKUPS, approvalFlags, draftMembers, memberKey, type Draft, type DraftMember } from "./model";
import { ApproveBox, StepHeading, TextButton } from "./ui";
import { useCopy } from "@/components/ui/copy";

export function ApproveStep({
  client,
  actConfigured,
  draft,
  onApprove,
  onMoveUp,
  onRemove,
  done,
  active,
}: {
  client: AgentSource;
  actConfigured: boolean;
  draft: Draft;
  onApprove: (key: string, approved: boolean) => void;
  onMoveUp: (key: string) => void;
  onRemove: (key: string) => void;
  done: boolean;
  active: boolean;
}) {
  const copy = useCopy();
  const members = draftMembers(draft);
  const unapproved = members.filter((m) => !m.approved).length;
  const slots: { label: string; member: DraftMember | null; empty: string }[] = [
    { label: copy.primary, member: draft.primary, empty: `Choose ${copy.primary === "Primary" ? "a primary" : copy.primary.toLowerCase()} in step 1` },
    ...Array.from({ length: Math.max(MAX_BACKUPS, draft.backups.length) }, (_, i) => ({
      label: `${copy.backup} ${i + 1}`,
      member: draft.backups[i] ?? null,
      empty: "Optional. Choose a backup in step 1",
    })),
  ];

  return (
    <div className="px-6 pb-6 pt-5 min-[1100px]:px-5">
      <StepHeading
        n={2}
        title="Approve"
        done={done}
        active={active}
        hint={
          client === "mock"
            ? "Approve each agent now, so overnight runs never stop to ask."
            : "Approve each agent now, including any sign-in or payment its provider asks for, so overnight runs never stop to ask."
        }
      />

      {client === "darwin" && (
        <div className="mt-3 pl-[34px] text-[12px]" style={{ color: actConfigured ? "var(--s-passed)" : "var(--s-verifying)" }}>
          {actConfigured
            ? "Real Darwin agents are connected."
            : "Darwin Act isn't connected yet, so agents from search stay unverified. Agents added by address are checked directly."}
        </div>
      )}

      <ul className="mt-4 flex flex-col gap-1.5 pl-[22px] min-[1100px]:pl-0">
        {slots.map(({ label, member, empty }, i) =>
          member ? (
            <MemberRow
              key={memberKey(member)}
              label={label}
              member={member}
              canMoveUp={i > 0}
              onApprove={(v) => onApprove(memberKey(member), v)}
              onMoveUp={() => onMoveUp(memberKey(member))}
              onRemove={() => onRemove(memberKey(member))}
            />
          ) : (
            <li key={label} className="flex items-center gap-3 rounded-[6px] border border-dashed border-line px-3 py-2.5 text-[12.5px]">
              <span className="w-[62px] shrink-0 text-muted">{label}</span>
              <span className="text-faint">{empty}</span>
            </li>
          ),
        )}
      </ul>

      {members.length > 0 && unapproved > 0 && (
        <p className="mt-3 pl-[34px] text-[12px] leading-relaxed text-muted min-[1100px]:pl-0">
          {unapproved === 1 ? "1 agent isn't" : `${unapproved} agents aren't`} approved. {unapproved === 1 ? "It is" : "They are"} saved but skipped during runs.
        </p>
      )}
    </div>
  );
}

function MemberRow({
  label,
  member,
  canMoveUp,
  onApprove,
  onMoveUp,
  onRemove,
}: {
  label: string;
  member: DraftMember;
  canMoveUp: boolean;
  onApprove: (v: boolean) => void;
  onMoveUp: () => void;
  onRemove: () => void;
}) {
  const flags = member.source === "darwin" ? approvalFlags(member.candidate) : [];
  return (
    <li className="rounded-[6px] bg-panel px-3 py-2.5">
      <div className="flex items-center gap-3">
        <span className="w-[62px] shrink-0 text-[12.5px] text-muted data-[wide]:w-[104px]" data-wide={label.length > 9 || undefined}>
          {label}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink" title={member.name}>
          {member.name}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {canMoveUp && (
            <TextButton onClick={onMoveUp} title={/ 1$/.test(label) ? "Make this the primary" : "Move up"} aria-label="Move up">
              ↑
            </TextButton>
          )}
          <TextButton onClick={onRemove} title="Remove from pool" aria-label="Remove" className="text-[15px] leading-none">
            ×
          </TextButton>
        </div>
      </div>
      <div className={`mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 ${label.length > 9 ? "pl-[116px]" : "pl-[74px]"}`}>
        <ApproveBox checked={member.approved} onChange={onApprove} name={`${label.toLowerCase()} ${member.name}`} />
        {flags.length > 0 && <span className="text-[12px] text-[var(--s-verifying)]">Includes {flags.join(" and ")}</span>}
      </div>
    </li>
  );
}
