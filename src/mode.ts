// The run mode, set at build time. DREX_MODE=loop builds the LLM loop (src/loop/), and the worker runs its LoopAgent in
// place of Agent. Unset, the build runs the agent as it did before.
declare const __DREX_MODE__: string | undefined;

export const MODE: string = typeof __DREX_MODE__ === "string" ? __DREX_MODE__ : "";

export function loopMode(): boolean {
  return MODE === "loop";
}
