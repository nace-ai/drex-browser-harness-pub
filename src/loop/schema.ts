// The action the LLM returns on each turn of the loop: its names, the JSON schema the API enforces on the reply, and
// the parser that checks a reply before the loop runs it.

export const LOOP_ACTIONS = [
  "page",
  "look",
  "read",
  "goto",
  "do",
  "click",
  "type",
  "point",
  "drag",
  "pick",
  "check",
  "answer",
] as const;

export type LoopActionName = (typeof LOOP_ACTIONS)[number];

/** How the run ended, said by the answer: the task is finished, or it could not be. */
export const LOOP_OUTCOMES = ["done", "not_done"] as const;

export type LoopOutcome = (typeof LOOP_OUTCOMES)[number];

/** The text for one field of a form: the field as the page names it, and what to type in it. */
export interface FieldText {
  field: string;
  text: string;
}

/** One action. A field the action doesn't use is "", [] or false ("done" for the outcome). */
export interface LoopAction {
  thought: string;
  action: LoopActionName;
  intent: string;
  expect: string;
  text: string;
  texts: FieldText[];
  url: string;
  urls: string[];
  js: string;
  find: string;
  el: string;
  enter: boolean;
  /** A point of the viewport in CSS pixels, "x,y": where point clicks and where drag starts. */
  at: string;
  /** Where drag lets go, "x,y". */
  to: string;
  rows: string[];
  question: string;
  choices: string[];
  claim: string;
  answer: string;
  /** Only an answer's outcome counts. It is the last field, so the LLM has written the answer before it judges it. */
  outcome: LoopOutcome;
}

// Typed against LoopAction, so a field added there cannot be left out of the schema.
const properties: Record<keyof LoopAction, unknown> = {
  thought: { type: "string" },
  action: { type: "string", enum: [...LOOP_ACTIONS] },
  intent: { type: "string" },
  expect: { type: "string" },
  text: { type: "string" },
  texts: {
    type: "array",
    items: {
      type: "object",
      properties: { field: { type: "string" }, text: { type: "string" } },
      required: ["field", "text"],
      additionalProperties: false,
    },
  },
  url: { type: "string" },
  urls: { type: "array", items: { type: "string" } },
  js: { type: "string" },
  find: { type: "string" },
  el: { type: "string" },
  enter: { type: "boolean" },
  at: { type: "string" },
  to: { type: "string" },
  rows: { type: "array", items: { type: "string" } },
  question: { type: "string" },
  choices: { type: "array", items: { type: "string" } },
  claim: { type: "string" },
  answer: { type: "string" },
  outcome: { type: "string", enum: [...LOOP_OUTCOMES] },
};

/** The reply's JSON schema. Structured output needs every field present, so the empty ones are sent too. */
export const ACTION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
};

const ELEMENT = /^[ED]\d+$/;
const POINT = /^\s*@?\s*\(?\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\)?\s*$/;

/** A point of the viewport in CSS pixels. */
export interface Point {
  x: number;
  y: number;
}

/** The point an at or to field names ("412,230", "(412, 230)", or "@412,230" as look's view prints a centre), or null
 * when it names none. */
export function parsePoint(text: string): Point | null {
  const m = POINT.exec(text);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}
const MAX_READ_URLS = 8;
const MAX_PICK_ROWS = 64;

/** Checks a reply and fills in the fields it leaves out; a field of the wrong type counts as left out. The error is
 * a short message for the LLM. */
export function parseAction(raw: unknown): LoopAction | { error: string } {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { error: "the action is not valid JSON" };
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "the action must be a JSON object" };
  }
  const o = value as Record<string, unknown>;
  const action = o.action;
  if (typeof action !== "string" || !isActionName(action)) {
    return { error: `unknown action ${JSON.stringify(action ?? "")}` };
  }
  const a: LoopAction = {
    thought: asText(o.thought),
    action,
    intent: asText(o.intent),
    expect: asText(o.expect),
    text: asText(o.text),
    texts: asFieldTexts(o.texts),
    url: asText(o.url),
    urls: asList(o.urls),
    js: asText(o.js),
    find: asText(o.find),
    el: asText(o.el),
    enter: o.enter === true,
    at: asText(o.at),
    to: asText(o.to),
    rows: asList(o.rows),
    question: asText(o.question),
    choices: asList(o.choices),
    claim: asText(o.claim),
    answer: asText(o.answer),
    outcome: o.outcome === "not_done" ? "not_done" : "done",
  };
  const problem = missing(a);
  return problem ? { error: problem } : a;
}

function isActionName(name: string): name is LoopActionName {
  return (LOOP_ACTIONS as readonly string[]).includes(name);
}

const asText = (v: unknown): string => (typeof v === "string" ? v : "");
const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x: unknown): x is string => typeof x === "string") : [];
const blank = (s: string): boolean => s.trim() === "";
/** The entries of a texts list that have both a field and a text; any other entry is left out. */
const asFieldTexts = (v: unknown): FieldText[] =>
  Array.isArray(v)
    ? v.flatMap((x: unknown): FieldText[] => {
        const pair = typeof x === "object" && x !== null ? (x as Record<string, unknown>) : {};
        const field = asText(pair.field);
        const text = asText(pair.text);
        return blank(field) || blank(text) ? [] : [{ field, text }];
      })
    : [];

/** What the action still needs, or "" when it has all of it. */
function missing(a: LoopAction): string {
  switch (a.action) {
    case "page":
    case "look":
      return "";
    case "read":
      if (blank(a.js) && blank(a.find)) return "read needs js or find";
      return a.urls.length > MAX_READ_URLS ? `read takes at most ${MAX_READ_URLS} urls, got ${a.urls.length}` : "";
    case "goto":
      return blank(a.url) ? "goto needs url" : "";
    case "do":
      return blank(a.intent) ? "do needs intent" : "";
    case "click":
      return ELEMENT.test(a.el) ? "" : "click needs el such as E12";
    case "type":
      if (!ELEMENT.test(a.el)) return "type needs el such as E12";
      return blank(a.text) ? "type needs text" : "";
    case "point":
      return parsePoint(a.at) ? "" : 'point needs at such as "412,230"';
    case "drag":
      if (!parsePoint(a.at)) return 'drag needs at, where it starts, such as "412,230"';
      return parsePoint(a.to) ? "" : 'drag needs to, where it lets go, such as "520,230"';
    case "pick":
      if (a.rows.length < 1 || a.rows.length > MAX_PICK_ROWS) return `pick needs 1 to ${MAX_PICK_ROWS} rows`;
      if (blank(a.question)) return "pick needs question";
      return a.choices.length < 2 ? "pick needs at least 2 choices" : "";
    case "check":
      return blank(a.claim) ? "check needs claim" : "";
    case "answer":
      return blank(a.answer) ? "answer needs answer" : "";
  }
}
