// Accuracy switches, set at build time (DREX_ACC="noteResolve,answerGuard" npm run build) so that the eval can run
// builds that differ in one of them side by side, like the cost switches of cost.ts. Unset, every switch is on;
// DREX_ACC=none turns them all off.
//
// noteResolve  a step that uses a list's note ({{note}} in its texts, or the note named in its goal) gets the value it
//              needs from one small LLM call instead of the note's JSON; a step that opens one of the list's matches
//              goes to that match's own page
// answerGuard  the final read must write the answer; an empty one is written from the read's own verdict, and an
//              answer the task wants as JSON is JSON
// answerRules  a page task's answer reports the page (it retrieves nothing); a thing shown not to exist is "not found"
// scanOn       an ordered list's scan does not stop at a row nothing settled: it goes on to a confirmed one
import { parseCost } from "./cost.ts";

declare const __DREX_ACC__: string | undefined;

export const ACC: Record<string, number | true> = parseCost(typeof __DREX_ACC__ === "string" ? __DREX_ACC__ : "");
export const accOn = (name: string): boolean => ACC[name] !== undefined && ACC[name] !== 0;

/** answerRules: what a page task's and a not-found answer report (the plan, the final read and the final answer). */
export const ANSWER_RULES =
  "A task to open, go to, view, show or pull up a page is done when that page is open: its answer reports reaching the page and retrieves no data from it (a navigation, not a retrieval). When the run looked where the thing the task asks about would be and it is not there, the answer reports it as not found (the format's not-found status when it has one), not as an unknown error or a validation error.";
