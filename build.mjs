// Builds the unpacked extension into dist/: bundles the service worker (the agent, with the Anthropic SDK) and the
// side panel, copies the static files, and writes the API keys from .env to dist/keys.local.json so they never end
// up inside the bundle or in git. dist/bridge.local.json holds this machine's path to mcp/server.mjs, for the setup
// command the panel shows.
//
// `node build.mjs --release` builds a release copy instead, in runner/extension/ (the copy the @nace-ai/browser package
// ships): no keys, no bridge.local.json, no sourcemaps, and it fails if the output holds a
// *.local.json file, anything shaped like an API key, or this machine's home directory.
import * as esbuild from "esbuild";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { releaseProblems } from "./scripts/check-release.mjs";

process.chdir(path.dirname(fileURLToPath(import.meta.url))); // the paths below are the repo's, whoever runs this
const release = process.argv.includes("--release");
const OUT = release ? "runner/extension" : "dist";
if (release) {
  const source = JSON.parse(fs.readFileSync("runner/protocol/source.json", "utf8"));
  const actual = createHash("sha256").update(fs.readFileSync("runner/protocol/run-spec.v2.json")).digest("hex");
  if (!/^[0-9a-f]{40}$/.test(source.commit) || source.sha256 !== actual)
    throw new Error("Browser protocol provenance is missing or the generated schema was edited.");
}

// node as the shell finds it (/opt/homebrew/bin/node, not a versioned Cellar path that an upgrade removes): coding agents
// started from the Dock don't see the shell's PATH, so their setup names node by its full path
let node = process.execPath;
if (!release) {
  try {
    node = execSync("command -v node", { encoding: "utf8", shell: "/bin/sh" }).trim() || node;
  } catch {}
  // mcp/server.mjs imports src/pairing.ts, which only a node with type stripping (22.18 or later) can load; a refused build leaves dist/ as it was
  let typescript = "";
  try {
    typescript = execFileSync(node, ["-p", "process.features.typescript"], { encoding: "utf8" }).trim();
  } catch {}
  if (!typescript || typescript === "undefined" || typescript === "false") {
    console.error(
      `node at ${node} can't run TypeScript, and mcp/server.mjs imports src/pairing.ts. Install Node 22.18 or later.`,
    );
    process.exit(1);
  }
}
fs.rmSync(OUT, { recursive: true, force: true });
for (const d of ["icons", "fonts", "brand"]) fs.mkdirSync(`${OUT}/${d}`, { recursive: true });

await esbuild.build({
  absWorkingDir: process.cwd(), // esbuild took its working directory before the chdir above
  entryPoints: ["src/background.ts", "src/sidepanel.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  outdir: OUT,
  sourcemap: !release,
  // the cost switches of src/cost.ts for this build: the measured set by default (2026-10-20: WebArena DEV $0.0042 an
  // attempt against $0.0134, at the same pass rate), DREX_COST=none for the agent as it worked before them
  define: {
    __DREX_COST__: JSON.stringify(
      process.env.DREX_COST === "none"
        ? ""
        : (process.env.DREX_COST ??
            "packText,llmTaskTrim,noThink,drexCompact,drexText,llmNoImage,staticSchema,verifyDrex,searchEnter,obsLite,collectLite"),
    ),
    // the accuracy switches of src/accuracy.ts: all on by default (the first four measured on WebArena DEV and
    // HOLDOUT-1; the four mechanics on the MiniWoB families they target, 102/140 vs 61/140 on the eval VM);
    // DREX_ACC=none builds without them, DREX_ACC="noteResolve,answerGuard" builds with just those
    __DREX_ACC__: JSON.stringify(
      process.env.DREX_ACC === "none"
        ? ""
        : (process.env.DREX_ACC ??
            "noteResolve,answerGuard,answerRules,scanOn,confirmedChanges,revealEvidence,dragTo,datePicker,pickSuggestion,copyMove"),
    ),
  },
  logLevel: "warning",
});

for (const f of ["manifest.json", "sidepanel.html", "sidepanel.css"]) fs.copyFileSync(`src/${f}`, `${OUT}/${f}`);
for (const d of ["icons", "fonts", "brand"])
  for (const f of fs.readdirSync(`src/${d}`)) fs.copyFileSync(`src/${d}/${f}`, `${OUT}/${d}/${f}`);

if (release) {
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = !!execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    encoding: "utf8",
  }).trim();
  fs.writeFileSync("runner/build-info.json", JSON.stringify({ sha, dirty, protocol: "2" }, null, 2) + "\n");
  const problems = releaseProblems(OUT);
  if (problems.length) {
    console.error(`release build refused:\n${problems.join("\n")}`);
    fs.rmSync(OUT, { recursive: true, force: true });
    process.exit(1);
  }
  console.log(`built ${OUT}/ (release: no keys, no local paths, no sourcemaps)`);
} else {
  fs.writeFileSync(`${OUT}/bridge.local.json`, JSON.stringify({ server: path.resolve("mcp/server.mjs"), node }));
  const env = fs.existsSync(".env")
    ? Object.fromEntries(
        fs
          .readFileSync(".env", "utf8")
          .split("\n")
          .filter((l) => /^\w+=/.test(l))
          .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
      )
    : {};
  const keys = {
    drexKey: env.DREX_API_KEY || "",
    anthropicKey: env.ANTHROPIC_API_KEY || "",
    openaiKey: env.OPENAI_API_KEY || "",
    fireworksKey: env.FIREWORKS_API_KEY || "",
    googleKey: env.GOOGLE_API_KEY || env.GEMINI_API_KEY || "",
    openrouterKey: env.OPENROUTER_API_KEY || "",
  };
  if (Object.values(keys).some(Boolean)) fs.writeFileSync(`${OUT}/keys.local.json`, JSON.stringify(keys));
  console.log(
    `built ${OUT}/ (keys from .env: ${Object.entries(keys)
      .map(([k, v]) => `${k.replace("Key", "")} ${v ? "yes" : "no"}`)
      .join(", ")})`,
  );
}
