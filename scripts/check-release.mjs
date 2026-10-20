// The release build's guard (build.mjs --release): what in its output could leak something of the machine that built it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// real keys, not the prefixes the extension matches pasted keys by (/^sk-ant-/ is in the bundle on purpose)
const KEY_SHAPES = [
  /sk-ant-[\w-]{20,}/,
  /sk-or-[\w-]{20,}/,
  /sk-(?:proj-)?[A-Za-z0-9]{32,}/,
  /nace_sk_\w{16,}/,
  /AIza[\w-]{30,}/,
  /fw_\w{20,}/,
];

/** The problems in dir, one line each: none for a clean release. */
export function releaseProblems(dir, home = os.homedir()) {
  const problems = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".local.json") || e.name.endsWith(".map")) problems.push(`${p}: not part of a release`);
      else if (/\.(js|json|html|css|txt)$/.test(e.name)) {
        const text = fs.readFileSync(p, "utf8");
        for (const shape of KEY_SHAPES) if (shape.test(text)) problems.push(`${p}: holds something shaped like a key`);
        if (home.length > 1 && text.includes(home)) problems.push(`${p}: holds this machine's home directory`);
      }
    }
  };
  walk(dir);
  return problems;
}
