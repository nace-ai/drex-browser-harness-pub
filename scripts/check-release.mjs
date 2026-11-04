// The release build's guards (build.mjs --release): what in its output could leak something of the machine that built it,
// and that each output holds the run mode it is named for.
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

/**
 * The run mode a built extension holds, read from its bundle (the src/mode.ts section, as esbuild emitted it): "" for
 * the default agent, "loop" for the loop, null when the bundle has no such section or it gives no string. It reads the
 * artifact, not the environment the build ran in, so a release that holds the other mode, or none, is caught.
 */
export function builtMode(dir) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, "background.js"), "utf8");
  } catch {
    return null;
  }
  const start = text.indexOf("// src/mode.ts\n");
  if (start < 0) return null;
  // up to the next module (or the export list a one-module bundle ends with)
  const ends = ["\n// src/", "\nexport "].map((m) => text.indexOf(m, start + 1)).filter((i) => i >= 0);
  const section = text.slice(start, ends.length ? Math.min(...ends) : undefined);
  try {
    const mode = new Function(`${section}\nreturn MODE;`)(); // a constant and a function of our own build's output
    return typeof mode === "string" ? mode : null;
  } catch {
    return null;
  }
}

/** One line when dir doesn't hold `mode` ("" is the default agent, "loop" the loop), none when it does. */
export function modeProblems(dir, mode) {
  const built = builtMode(dir);
  if (built === mode) return [];
  const name = (m) => (m === null ? "no readable run mode" : m === "" ? "the default mode" : `the ${m} mode`);
  return [`${dir}: should hold ${name(mode)}, but holds ${name(built)}`];
}
