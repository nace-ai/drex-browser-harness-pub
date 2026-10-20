// Page scripts are template strings sent to the page, outside the type checker. Type syntax inside one passes tsc and
// then breaks every run, so each must parse as plain JavaScript.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const dir = path.join(import.meta.dirname, "..", "src");
const START = /^(function|\(function|\(\(\) =>|\(async)/;

function pageScripts() {
  const found = [];
  for (const name of fs.readdirSync(dir).filter((n) => /\.(js|ts)$/.test(n))) {
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      let cooked = null;
      if (ts.isNoSubstitutionTemplateLiteral(node)) cooked = node.text;
      else if (ts.isTemplateExpression(node))
        cooked = node.head.text + node.templateSpans.map((s) => "null" + s.literal.text).join("");
      if (cooked !== null && START.test(cooked.trim()))
        found.push({
          file: `src/${name}`,
          line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          text: cooked.trim(),
        });
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

const scripts = pageScripts();

test("every page script parses as plain JavaScript", () => {
  for (const s of scripts) assert.doesNotThrow(() => new vm.Script("(" + s.text + ")"), `${s.file}:${s.line}`);
});

test("page scripts were found", () => {
  assert.ok(scripts.length >= 20, `found ${scripts.length}`);
});
