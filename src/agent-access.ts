// What a paired coding agent may do through the bridge (bridge.ts), kept free of browser APIs so it can be tested.
import type { RunOver } from "./types.ts";

/** The run options a coding agent's run gets: a risky action always asks, whatever the panel's "Ask before risky
 * actions" setting, so it ends the run as a hand-over (report mode) instead of being clicked unasked. */
export function agentRunOver(expect: string | undefined, plan: unknown): RunOver {
  const over: RunOver = { report: { expect: expect || "" }, approvals: true };
  if (plan != null) over.planning = !!plan;
  return over;
}

/** Whether a coding agent may look at a tab: only the tabs its own runs opened or worked in, never the person's other
 * tabs (their mail, their bank). */
export function agentMayRead(id: number, seen: ReadonlySet<number>): boolean {
  return seen.has(id);
}
