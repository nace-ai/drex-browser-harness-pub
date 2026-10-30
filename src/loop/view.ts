// The page as the LLM reads it between actions: the address and title, the main text, and the controls with the
// labels (E# on screen, D# off screen) that the actions name.
import type { PageEl } from "../types.ts";
import { clip } from "./read.ts";

/** How much of a page the LLM sees: characters of text, and controls on screen and off it. */
export interface ViewLimits {
  text: number;
  controls: number;
  off: number;
}

export const FULL_VIEW: ViewLimits = { text: 4000, controls: 150, off: 40 };
export const SHORT_VIEW: ViewLimits = { text: 1200, controls: 40, off: 10 };

// A name, state or option with a line break would split its control over two lines, so whitespace runs become one
// space first.
const flat = (s: string): string => s.replace(/\s+/g, " ").trim();

/** What a control is called in a view: the role and the name its line gives it, which is all the LLM knows of it. */
export interface ControlId {
  role: string;
  name: string;
}

/** The role and name of a control, as controlLine shows them. */
export function controlId(el: PageEl): ControlId {
  return { role: el.role || "control", name: clip(flat(el.name || el.text), 80) };
}

/** One control on one line: its label, role, name, state and, for a select, its first options. With at, an on-screen
 * control also gets the point at its centre, in CSS pixels ("@412,230"): what point and drag take. */
export function controlLine(el: PageEl, at = false): string {
  const { role, name } = controlId(el);
  let line = `${el.label} ${role} "${name}"`;
  if (at && el.box) line += ` @${Math.round((el.box[0] + el.box[2]) / 2)},${Math.round((el.box[1] + el.box[3]) / 2)}`;
  const state = el.state ? flat(el.state) : "";
  if (state) line += ` (${state})`;
  if (el.select && el.options?.length) {
    const options = el.options.slice(0, 8).map((o) => clip(flat(o), 40));
    line += ` options: ${options.join(" | ")}`;
  }
  return line;
}

export function pageView(
  info: { title: string; url: string; text: string },
  els: PageEl[],
  off: PageEl[],
  limits: ViewLimits,
  at = false,
): string {
  // Spaces and tabs are collapsed and blank lines dropped, so the text spends its characters on words.
  const body = info.text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
  const cut = body.length > limits.text;
  const shown = cut ? clip(body, limits.text) : body;
  const header = cut
    ? `TEXT (${shown.length} of ${body.length} characters; read with find or js for the rest):`
    : `TEXT (${body.length} characters):`;
  const lines = [`PAGE: "${info.title}" — ${info.url}`, header, shown, "CONTROLS ON SCREEN:"];
  const onShown = els.slice(0, limits.controls);
  lines.push(...onShown.map((el) => controlLine(el, at)));
  if (els.length > onShown.length) lines.push(`(${els.length - onShown.length} more on screen)`);
  if (off.length > 0) {
    const offShown = off.slice(0, limits.off);
    lines.push("OFF SCREEN:", ...offShown.map((el) => controlLine(el)));
    if (off.length > offShown.length) lines.push(`(${off.length - offShown.length} more off screen)`);
  }
  return lines.join("\n");
}
