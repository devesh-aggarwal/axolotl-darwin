// Which story the app tells. Both run on the same engine, checks and failover.
//   workflow   (Option A): a workflow built from Darwin agents; pre-approved Darwin backups take over.
//   your-agent (Option B): the team's own agent goes first; Darwin agents take over when it fails.
// Set AXOLOTL_MODE=your-agent in .env (and restart) for Option B. Pools are kept per mode, so
// switching back and forth doesn't overwrite either setup.
export type ProductMode = "workflow" | "your-agent";

export function productMode(): ProductMode {
  return process.env.AXOLOTL_MODE === "your-agent" ? "your-agent" : "workflow";
}

export interface ModeCopy {
  /** One line under the name in the top bar. */
  tagline: string;
  /** Role names in setup and the agent pool. */
  primary: string;
  backup: string;
  /** Hint above the agent search in setup. */
  pickHint: (maxBackups: number) => string;
  /** Story line when a backup takes over. */
  switched: (name: string) => string;
  /** Count of steps a backup rescued. */
  recovered: string;
}

export const MODE_COPY: Record<ProductMode, ModeCopy> = {
  workflow: {
    tagline: "Self-healing agent workflows on Darwin",
    primary: "Primary",
    backup: "Backup",
    pickHint: (n) => `Search for agents that can do this step, then choose one primary and up to ${n} backups.`,
    switched: (name) => `Switched to ${name}`,
    recovered: "Failures recovered",
  },
  "your-agent": {
    tagline: "Your agent fails at 3am, Darwin finishes the job",
    primary: "Your agent",
    backup: "Darwin backup",
    pickHint: (n) => `Your agent goes first. Pick up to ${n} Darwin agents to take over when it fails. Add your agent by its address below.`,
    switched: (name) => `Handed to Darwin backup ${name}`,
    recovered: "Jobs Darwin finished",
  },
};
