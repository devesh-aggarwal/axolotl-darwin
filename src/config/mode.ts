// Which story the app tells. Both run on the same engine, checks and failover.
//   workflow   (Option A): a workflow built from Darwin agents; when one fails, Axolotl finds another through Darwin.
//   your-agent (Option B): the team's own agent goes first; Darwin agents take over when it fails.
// Set AXOLOTL_MODE=your-agent in .env (and restart) for Option B. Either way, agents are found and
// checked at run time; nobody approves them in advance.
export type ProductMode = "workflow" | "your-agent";

export function productMode(): ProductMode {
  return process.env.AXOLOTL_MODE === "your-agent" ? "your-agent" : "workflow";
}

export interface ModeCopy {
  /** One line under the name in the top bar. */
  tagline: string;
  /** Story line when a backup takes over. */
  switched: (name: string) => string;
  /** Count of steps a backup rescued. */
  recovered: string;
}

export const MODE_COPY: Record<ProductMode, ModeCopy> = {
  workflow: {
    tagline: "Self-healing agent workflows on Darwin",
    switched: (name) => `Switched to ${name}`,
    recovered: "Failures recovered",
  },
  "your-agent": {
    tagline: "Your agent fails at 3am, Darwin finishes the job",
    switched: (name) => `Handed to Darwin backup ${name}`,
    recovered: "Jobs Darwin finished",
  },
};
