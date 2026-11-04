// The package ships one extension build per agent mode (build.mjs --release): both must be in the package, and each
// must load in Chromium. Both need the release build (npm run build:release); the second also Playwright's Chromium.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MODES } from "../runner/src/args.mjs";
import { extensionDir, launch } from "../runner/src/run.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function why() {
  for (const mode of MODES)
    try {
      extensionDir({}, mode);
    } catch {
      return `needs npm run build:release (no ${mode} build)`;
    }
  return "";
}
const reason = why();
// CI builds the release: a skip there would hide a mode that is missing from it
if (reason && process.env.NACE_REQUIRE_BROWSER_TESTS === "1") throw new Error(`Mode build test ${reason}.`);
const skip = reason || false; // node:test reports an empty reason as a skip too

test("npm pack ships the extension of every mode", { skip }, () => {
  // --ignore-scripts: prepack would rebuild runner/extension* under the other tests that load them
  const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "-w", "runner"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const files = JSON.parse(r.stdout)[0].files.map((f) => f.path);
  for (const dir of ["extension", "extension-loop"])
    for (const f of ["manifest.json", "background.js", "sidepanel.js"])
      assert.ok(files.includes(`${dir}/${f}`), `${dir}/${f} is not in the package`);
  assert.ok(!files.some((f) => /\.local\.json$|\.map$/.test(f)), "the package holds a local file or a sourcemap");
});

let chromium = "";
if (!reason) {
  const { chromium: c } = await import("playwright");
  if (!fs.existsSync(c.executablePath())) chromium = "needs nace-browser install";
}
if (chromium && process.env.NACE_REQUIRE_BROWSER_TESTS === "1") throw new Error(`Mode build test ${chromium}.`);

for (const mode of MODES)
  test(
    `the ${mode} extension loads in Chromium and its worker starts`,
    { skip: skip || chromium || false },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-mode-"));
      let ctx;
      try {
        ctx = await launch(dir, { headless: true, extension: extensionDir({}, mode) });
        const ours = (w) => w.url().startsWith("chrome-extension://");
        const sw =
          ctx.serviceWorkers().find(ours) ??
          (await ctx.waitForEvent("serviceworker", { predicate: ours, timeout: 30000 }));
        // the panel page is the extension page the runner sends runs from: it must open and reach the worker
        const panel = await ctx.newPage();
        await panel.goto(`chrome-extension://${new URL(sw.url()).host}/sidepanel.html`);
        const answered = await panel.evaluate(
          () =>
            new Promise((resolve) => {
              const port = chrome.runtime.connect({ name: "panel" });
              port.onMessage.addListener((m) => m.type === "lastRun" && resolve(true));
              port.postMessage({ type: "lastRun" });
              setTimeout(() => resolve(false), 10000);
            }),
        );
        assert.equal(answered, true, "the worker did not answer the panel");
      } finally {
        await ctx?.close().catch(() => {});
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
