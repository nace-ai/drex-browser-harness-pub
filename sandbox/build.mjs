// Build an isolated E2B candidate from the very same npm tarball installed
// locally. No .env, checkout, or provider credentials enter the build context.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { Template } from "e2b";

const repo = path.resolve(import.meta.dirname, "..");
process.chdir(repo);
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
if (git("status", "--porcelain")) throw new Error("Commit and validate the candidate before building a template.");
const sha = git("rev-parse", "HEAD");
const context = path.join(repo, ".worker-releases", sha);
fs.mkdirSync(context, { recursive: true });
const manifest = path.join(context, "manifest.json");
if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).templateId)
  throw new Error("This source already has a built candidate. Use its saved manifest; do not overwrite a release.");
// a rebuild of the same commit must hash the archive it packs now, not the one an earlier build left
for (const f of fs.readdirSync(context)) if (f.endsWith(".tgz")) fs.rmSync(path.join(context, f));
execFileSync("npm", ["pack", "--workspace", "runner", "--pack-destination", context], { stdio: "inherit" });
const archive = fs.readdirSync(context).find((f) => f.endsWith(".tgz"));
if (!archive) throw new Error("npm pack produced no archive.");
fs.renameSync(path.join(context, archive), path.join(context, "browser.tgz"));
const hash = (file) =>
  createHash("sha256")
    .update(fs.readFileSync(path.join(context, file)))
    .digest("hex");
const installed = (lock) =>
  Object.entries(lock.packages)
    .filter(([key, entry]) => key.includes("node_modules/") && entry.version && !entry.link)
    .map(([key, entry]) => [key.slice(key.lastIndexOf("node_modules/") + 13), entry.version]);
const testedLock = installed(JSON.parse(fs.readFileSync(path.join(repo, "package-lock.json"), "utf8")));
const tested = new Set(testedLock.map(([name, version]) => `${name}@${version}`));
// Pin each dependency the repo lock has at one version, so the resolve below reuses what CI tested, not the latest.
const counts = new Map();
for (const [name] of testedLock) counts.set(name, (counts.get(name) ?? 0) + 1);
const overrides = Object.fromEntries(
  testedLock.filter(([name]) => counts.get(name) === 1 && name !== "@nace-ai/browser"),
);
fs.writeFileSync(
  path.join(context, "package.json"),
  JSON.stringify(
    {
      private: true,
      dependencies: { "@nace-ai/browser": "file:browser.tgz" },
      overrides,
    },
    null,
    2,
  ),
);
// Resolve once, then npm ci in E2B installs this exact lock. Keep both with the manifest.
execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: context,
  stdio: "inherit",
});
// The image must run the dependency versions CI tested: refuse any the resolve picked that the repo lock lacks.
const untested = installed(JSON.parse(fs.readFileSync(path.join(context, "package-lock.json"), "utf8")))
  .map(([name, version]) => `${name}@${version}`)
  .filter((id) => !id.startsWith("@nace-ai/browser@") && !tested.has(id));
if (untested.length) throw new Error(`Release dependencies differ from package-lock.json: ${untested.join(", ")}`);
fs.copyFileSync(path.join(repo, "sandbox/entrypoint.sh"), path.join(context, "entrypoint.sh"));
const baseImage = "node:22.18.0-bookworm@sha256:3266bc9e8bee1acc8a77386eefaf574987d2729b8c5ec35b0dbd6ddbc40b0ce2";
const template = Template({ fileContextPath: context })
  .fromImage(baseImage)
  .setUser("root")
  .setWorkdir("/opt/browser")
  .copy(["package.json", "package-lock.json", "browser.tgz", "entrypoint.sh"], "/opt/browser/")
  .setEnvs({
    PLAYWRIGHT_BROWSERS_PATH: "/opt/browsers",
    // E2B installs this CA at boot for its credential-injecting HTTPS proxy.
    NODE_EXTRA_CA_CERTS: "/usr/local/share/ca-certificates/e2b-ca.crt",
  })
  .runCmd("npm ci --omit=dev --ignore-scripts --no-audit --no-fund")
  .runCmd("node node_modules/@nace-ai/browser/bin/nace-browser.mjs install --with-deps")
  .runCmd("chmod 755 /opt/browser/entrypoint.sh && ln -s /opt/browser/entrypoint.sh /usr/local/bin/drex-browser-run");
fs.writeFileSync(path.join(context, "Dockerfile"), Template.toDockerfile(template));
const identity = {
  source_sha: sha,
  protocol_version: "2",
  base_image: baseImage,
  package_sha256: hash("browser.tgz"),
  lock_sha256: hash("package-lock.json"),
  alias: `drex-browser-worker-${sha.slice(0, 12)}-${randomUUID().slice(0, 8)}`,
};
fs.writeFileSync(manifest, JSON.stringify(identity, null, 2) + "\n");
if (!process.argv.includes("--build")) {
  console.log(`Prepared ${context}; use --build to build this E2B candidate.`);
} else {
  const built = await Template.build(template, identity.alias, {
    apiKey: process.env.E2B_API_KEY,
    cpuCount: 2,
    memoryMB: 2048,
    onBuildLogs: (entry) => console.log(entry.message),
  });
  fs.writeFileSync(manifest, JSON.stringify({ ...identity, ...built }, null, 2) + "\n");
  console.log(JSON.stringify({ ...identity, ...built }));
}
