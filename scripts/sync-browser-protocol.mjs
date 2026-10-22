// Copy the published contract from a committed Drex checkout. Generated files
// are verified by checksum; edit the schema at its owner, never in this package.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const repo = process.argv[2];
if (!repo) throw new Error("Usage: node scripts/sync-browser-protocol.mjs /path/to/drex");
const file = "packages/browser-protocol/run-spec.v2.json";
const commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const bytes = execFileSync("git", ["-C", repo, "show", `${commit}:${file}`]);
const dest = new URL("../runner/protocol/", import.meta.url);
fs.mkdirSync(dest, { recursive: true });
fs.writeFileSync(new URL("run-spec.v2.json", dest), bytes);
fs.writeFileSync(
  new URL("source.json", dest),
  JSON.stringify(
    {
      repository: "nace-ai/drex",
      commit,
      path: file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    null,
    2,
  ) + "\n",
);
console.log(`Imported browser protocol from Drex ${commit}`);
