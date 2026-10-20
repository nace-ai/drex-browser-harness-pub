// Every $("id", HTMLXElement) lookup in the side panel must find its element in sidepanel.html, with the tag the constructor
// names: $ throws at lookup, so one wrong id or tag would break the whole panel at load.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const script = fs.readFileSync("src/sidepanel.ts", "utf8");
const html = fs.readFileSync("src/sidepanel.html", "utf8");
const TAGS = {
  HTMLInputElement: "input",
  HTMLButtonElement: "button",
  HTMLSelectElement: "select",
  HTMLTextAreaElement: "textarea",
  HTMLDivElement: "div",
  HTMLFormElement: "form",
  HTMLAnchorElement: "a",
  HTMLImageElement: "img",
  HTMLParagraphElement: "p",
  HTMLSpanElement: "span",
  HTMLOListElement: "ol",
  HTMLPreElement: "pre",
  HTMLElement: null,
  SVGElement: "svg",
};
const tagOf = (id) => html.match(new RegExp(`<([a-z0-9]+)\\b[^>]*\\bid="${id}"`))?.[1];

test("every $() lookup in the side panel matches an element in sidepanel.html", () => {
  const calls = [...script.matchAll(/\$\("([\w-]+)"(?:,\s*(\w+))?\)/g)].map((m) => ({ id: m[1], type: m[2] }));
  assert.ok(calls.length > 40, `found only ${calls.length} lookups`);
  for (const { id, type } of calls) {
    const tag = tagOf(id);
    assert.ok(tag, `#${id} is not in sidepanel.html`);
    assert.ok(type in TAGS, `#${id}: unknown element type ${type}`);
    if (TAGS[type]) assert.equal(tag, TAGS[type], `#${id} is a <${tag}> but looked up as ${type}`);
  }
});

test("the side panel looks up the elements it needs", () => {
  const ids = new Set([...script.matchAll(/\$\("([\w-]+)"/g)].map((m) => m[1]));
  assert.ok(ids.has("task") && ids.has("liveCursor"));
});
