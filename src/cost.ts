// Cost switches, set at build time (DREX_COST="noThink,drexText,cap=0.006" npm run build) so that the eval can run
// builds that differ in one of them side by side. Unset, every switch is off and the agent works as before.
import { visualQuestion } from "./context.ts";
import { compactOptions, taskForMoves } from "./logic.ts";

declare const __DREX_COST__: string | undefined;

export function parseCost(spec: string): Record<string, number | true> {
  const out: Record<string, number | true> = {};
  for (const part of spec.split(",")) {
    const [name, value] = part.split("=").map((s) => s.trim());
    if (!name) continue;
    out[name] = value === undefined || value === "" ? true : Number(value);
  }
  return out;
}

export const COST: Record<string, number | true> = parseCost(typeof __DREX_COST__ === "string" ? __DREX_COST__ : "");
export const costOn = (name: string): boolean => COST[name] !== undefined && COST[name] !== 0;
export const costValue = (name: string, fallback: number): number =>
  typeof COST[name] === "number" && Number.isFinite(COST[name]) ? COST[name] : fallback;

/** The screenshots a Drex decision gets. With the drexText switch none, unless the task is about how things look or
 * nothing on the screen could be tagged: the tagged elements' text carries the rest. */
export function drexImages(task: string, scr: { els?: unknown[] }, ...images: string[]): string[] {
  if (!costOn("drexText") || visualQuestion(taskForMoves(task)) || !scr.els?.length) return images;
  return [];
}

/** The task as Drex reads it: with the drexCompact switch, without its answer-format paragraphs. */
export const movesTask = (task: string): string => (costOn("drexCompact") ? taskForMoves(task) : task);

/** Move options as Drex reads them: with the drexCompact switch, each element's surrounding text clipped. */
export const moveOptions = (opts: Record<string, string>): Record<string, string> =>
  costOn("drexCompact") ? compactOptions(opts) : opts;
