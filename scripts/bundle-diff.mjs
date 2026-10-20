// Bundles the extension entry points at a git ref and at the working tree, then diffs them as one statement per line,
// so a refactor that claims "no runtime change" can prove it. Usage: node scripts/bundle-diff.mjs [ref=HEAD]
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import esbuild from "esbuild";

const ref = process.argv[2] || "HEAD";
const root = path.resolve(import.meta.dirname, "..");
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

async function bundle(dir, name) {
  const entry = ["ts", "js"].map((ext) => path.join(dir, "src", `${name}.${ext}`)).find((f) => fs.existsSync(f));
  if (!entry) throw new Error(`no src/${name}.{ts,js} in ${dir}`);
  const { outputFiles } = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    packages: "external",
    minifyWhitespace: true,
    write: false,
    logLevel: "silent",
  });
  return (await esbuild.transform(outputFiles[0].text, { format: "esm" })).code;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-diff-"));
const base = path.join(tmp, "base");
let added = false;
try {
  git("worktree", "add", "--detach", base, ref);
  added = true;
  for (const name of ["background", "sidepanel"]) {
    fs.writeFileSync(path.join(tmp, `old-${name}.js`), await bundle(base, name));
    fs.writeFileSync(path.join(tmp, `new-${name}.js`), await bundle(root, name));
  }
  let lines = [];
  for (const name of ["background", "sidepanel"]) {
    const r = spawnSync(
      "git",
      ["diff", "--no-index", "--no-color", "--", path.join(tmp, `old-${name}.js`), path.join(tmp, `new-${name}.js`)],
      { encoding: "utf8", maxBuffer: 1 << 28 },
    );
    if (r.error || r.status > 1 || (r.status === 1) !== Boolean(r.stdout))
      throw new Error(`git diff failed for ${name}: ${r.error?.message ?? `status ${r.status}`} ${r.stderr ?? ""}`);
    if (r.stdout) {
      process.stdout.write(r.stdout);
      lines.push(...r.stdout.split("\n"));
    }
  }
  const body = lines.filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  const awaits = (sign) => body.filter((l) => l[0] === sign && /\bawait\b/.test(l)).length;
  console.log(
    body.length
      ? `bundle-diff: ${body.length} changed lines, ${awaits("+") - awaits("-")} added await`
      : "bundle-diff: identical",
  );
} finally {
  if (added) git("worktree", "remove", "--force", base);
  fs.rmSync(tmp, { recursive: true, force: true });
}
