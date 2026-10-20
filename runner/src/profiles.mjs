// Where the runner keeps its browser profiles, and the lock that lets one run at a time use a profile.
// Profiles live in ~/.nace/browser/profiles/<name> (NACE_BROWSER_HOME moves ~/.nace/browser, for tests and sandboxes).
// A profile is a Chromium user-data directory: the cookies of the sites you signed in to with `nace-browser login`.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PROFILE = "default";
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class ProfileBusy extends Error {
  constructor(name, holder, file) {
    super(
      `Profile "${name}" is in use by another nace-browser process (pid ${holder?.pid ?? "unknown"}` +
        `${holder?.command ? `, ${holder.command}` : ""}${holder?.host ? ` on ${holder.host}` : ""}). Wait for it ` +
        `to finish, or use --profile with another name. If that process is gone, delete ${file}.`,
    );
    this.name = "ProfileBusy";
    this.code = "profile_busy";
  }
}

/** ~/.nace/browser, or NACE_BROWSER_HOME. */
export function home(env = process.env) {
  return env.NACE_BROWSER_HOME ? path.resolve(env.NACE_BROWSER_HOME) : path.join(os.homedir(), ".nace", "browser");
}

export function checkProfileName(name) {
  if (typeof name !== "string" || !NAME.test(name))
    throw new Error(`Invalid profile name ${JSON.stringify(name)}: use letters, digits, - and _ (at most 64).`);
  return name;
}

export function profileDir(name, env = process.env) {
  return path.join(home(env), "profiles", checkProfileName(name));
}

const lockPath = (name, env) => path.join(home(env), "profiles", `${checkProfileName(name)}.lock`);

/** True when a process with this pid is running (on this machine). */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // it exists, under another user
  }
}

// the ids of the locks this process holds: a lock with our pid that isn't one of them was left by an earlier process
// that had the same pid (a restarted container), which is gone. An id, not the file's path: on a case-insensitive disk
// "Work" and "work" are one lock under two paths
const ours = new Set();

/** Whether a lock's holder still runs. Another machine's lock (a shared home) can't be checked, so it counts as held. */
function holds(holder) {
  if (holder.host !== os.hostname()) return true;
  return holder.pid === process.pid ? ours.has(holder.id) : alive(holder.pid);
}

function readHolder(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Takes the profile's lock, or throws ProfileBusy. A lock whose process is gone (a crash, a kill -9) is taken over.
 * The lock file appears whole and only if there is none (a hard link of a file already written), so two processes
 * starting at once can't both get it, and nobody reads a half-written lock.
 * Returns release(), which is safe to call more than once.
 */
export function lockProfile(name, { env = process.env, command = "" } = {}) {
  const pid = process.pid;
  const file = lockPath(name, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const id = randomUUID();
  const body = JSON.stringify({ pid, id, command, started: new Date().toISOString(), host: os.hostname() });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (create(file, body)) {
      ours.add(id);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        ours.delete(id);
        // only our own lock: a stale-lock takeover by another process must not be undone by us
        if (readHolder(file)?.id === id) fs.rmSync(file, { force: true });
      };
    }
    const holder = readHolder(file);
    if (holder && holds(holder)) throw new ProfileBusy(name, holder, file);
    // stale: its process is gone, or the file is unreadable
    if (!takeOver(file, holder)) throw new ProfileBusy(name, readHolder(file), file);
  }
  throw new ProfileBusy(name, readHolder(file), file);
}

/** Creates file with body, whole, unless it exists. False when it does. */
function create(file, body) {
  const draft = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(draft, body);
  try {
    fs.linkSync(draft, file);
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  } finally {
    fs.rmSync(draft, { force: true });
  }
}

/**
 * Removes a stale lock, if it is still the one found stale. One process at a time does it, under a guard file: two
 * that both found the lock stale would otherwise race, the second removing the lock the first has just taken.
 * False when another process is taking it over now (it will hold the profile).
 */
function takeOver(file, stale) {
  const guard = `${file}.takeover`;
  if (!create(guard, String(process.pid))) {
    // a guard left by a process that died in the middle of a takeover (it holds it for a moment only); one that is
    // gone already was just released, and whatever guard is there now may be another process's fresh one
    const made = fs.statSync(guard, { throwIfNoEntry: false })?.mtimeMs;
    if (made !== undefined && Date.now() - made > 10000) fs.rmSync(guard, { force: true });
    return false;
  }
  try {
    if (JSON.stringify(readHolder(file)) === JSON.stringify(stale)) fs.rmSync(file, { force: true });
  } finally {
    fs.rmSync(guard, { force: true });
  }
  return true;
}

/** The saved profiles: name, path, whether a run holds it now, and when it was last used. */
export function listProfiles(env = process.env) {
  const dir = path.join(home(env), "profiles");
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && NAME.test(e.name))
    .flatMap((e) => {
      const p = path.join(dir, e.name);
      const stat = fs.statSync(p, { throwIfNoEntry: false }); // removed since it was listed
      if (!stat) return [];
      const file = path.join(dir, `${e.name}.lock`);
      const holder = readHolder(file);
      return [{ name: e.name, path: p, in_use: !!holder && holds(holder), last_used: stat.mtime.toISOString() }];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// --- temporary profiles ---------------------------------------------------------------------------------------------
// A run with --temp-profile (a sandbox, a one-off run) gets a fresh profile in the temp directory, removed on every way
// out: the run's own finally, and process exit (a second Ctrl-C, a SIGTERM the run didn't finish within). Leaked
// profiles once filled a VM's /tmp inodes (e2e/run.py, ~2,850 of them). Named profiles are never removed.
const temporary = new Set();
const removeTemporary = () => {
  for (const d of temporary) removeDir(d);
};

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {}
}

/** A fresh profile directory under NACE_BROWSER_TMP or the OS temp dir. remove() deletes it (once; safe to repeat). */
export function makeTempProfile(env = process.env) {
  const root = env.NACE_BROWSER_TMP ? path.resolve(env.NACE_BROWSER_TMP) : os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "nace-browser-"));
  temporary.add(dir);
  keepTempCleanupLast();
  return {
    dir,
    remove() {
      if (!temporary.delete(dir)) return;
      removeDir(dir);
    },
  };
}

/**
 * Moves the exit hook that removes temporary profiles behind every exit listener added so far. Called after launch():
 * Playwright's exit handler, which kills Chromium, must run first, or Chromium writes parts of a removed profile back.
 */
export function keepTempCleanupLast() {
  process.removeListener("exit", removeTemporary);
  process.on("exit", removeTemporary);
}
