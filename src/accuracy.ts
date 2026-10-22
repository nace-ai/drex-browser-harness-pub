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
// settingReadback  a step that sets a filter, sort, option or typed value is done only when the page shows it applied
// revealEvidence  the end of a run shows the facts its answer cites on screen
// confirmedChanges  a click's own site requests and notices are the run's record of what it changed; a change that
//              record confirms is never answered with an error status
// dragTo        Drex drags one tagged element onto another when the step or task speaks of dragging, moving or
//              sorting (and the LLM can ask for it by labels on any step)
// datePicker    a read-only date field is set through its calendar in one move
// pickSuggestion after typing into an autocomplete field the matching suggestion is committed
// copyMove      Drex copies one element's text into a field without the clipboard
// deadUrls     (off unless named) a step's guessed address that shows a not-found page is left: the run goes back, no
//              step opens it again, and the step gets there through the site's own links
// navMap       (off unless named) the planner gets the active site's own navigation links (menus, side bar, footer,
//              hidden menu items too) with their menu paths, and takes routes from it instead of made-up addresses
// longSelects  (off unless named) a native select with more than 30 options keeps them: the fill macro reads them all,
//              and Drex is offered the ones the step or task names
// frames       (off unless named) the controls of same-process iframes (a calculator, a quiz) are listed with the
//              page's, their boxes moved to the page's viewport
import { parseCost } from "./cost.ts";

declare const __DREX_ACC__: string | undefined;

export const ACC: Record<string, number | true> = parseCost(typeof __DREX_ACC__ === "string" ? __DREX_ACC__ : "");
export const accOn = (name: string): boolean => ACC[name] !== undefined && ACC[name] !== 0;

/** answerRules: what a page task's and a not-found answer report (the plan, the final read and the final answer). */
export const ANSWER_RULES =
  "A task to open, go to, view, show or pull up a page is done when that page is open: its answer reports reaching the page and retrieves no data from it (a navigation, not a retrieval). When the run looked where the thing the task asks about would be and it is not there, the answer reports it as not found (the format's not-found status when it has one), not as an unknown error or a validation error.";

/** confirmedChanges: how the final answer reports the changes the run's record holds (the notes confirmed_changes and
 * rejected_changes). */
export const CHANGE_RULE =
  "Recorded changes: a change in confirmed_changes is reported with the success status; a change in rejected_changes with the failure status.";
