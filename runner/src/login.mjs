// `nace-browser login URL`: a visible Chromium window on a saved profile, where a person signs in to a site. The
// profile keeps the session, so later runs on it are signed in. The agent never types credentials: a run that meets
// a sign-in screen ends blocked_login, and this is how the person gets past it.
import fs from "node:fs";
import { lockProfile, profileDir } from "./profiles.mjs";
import { RunnerError, launch } from "./run.mjs";

export const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

/** Opens the window and resolves when the person closes it (or after timeoutMs). */
export async function login(
  { url, profile },
  { env = process.env, timeoutMs = LOGIN_TIMEOUT_MS, signal, handleSignals = true } = {},
) {
  if (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY)
    throw new RunnerError("no_display", "login opens a browser window, and this machine has no display.");
  if (signal?.aborted) return { profile, url, ended: "cancelled", profile_path: profileDir(profile, env) };
  const release = lockProfile(profile, { env, command: `login ${url}` });
  let ctx = null;
  // one close for the abort and the finally: a second ctx.close() returns before the first has finished, and the lock
  // released then lets the next run meet the Chromium still shutting down on the profile
  let closing = null;
  const close = () => (closing ??= ctx.close().catch(() => {}));
  // watched from the start: a cancel while Chromium starts or the page loads would otherwise wait out the timeout
  let onAbort;
  const cancelled = new Promise((resolve) => {
    onAbort = () => {
      resolve("cancelled");
      if (ctx) void close();
    };
    if (signal?.aborted) resolve("cancelled");
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const dir = profileDir(profile, env);
    fs.mkdirSync(dir, { recursive: true });
    ctx = await launch(dir, { headless: false, extension: null, handleSignals });
    if (signal?.aborted) return { profile, url, ended: "cancelled", profile_path: dir };
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    // watched before the first page loads: a window closed during the load would otherwise wait out the timeout
    const closed = new Promise((resolve) => {
      ctx.on("close", () => resolve("closed"));
      // on macOS closing the last window leaves Chromium running: the last tab closing ends the login too
      const watch = (p) =>
        p.on("close", () => {
          if (ctx.pages().length === 0) resolve("closed");
        });
      ctx.pages().forEach(watch);
      ctx.on("page", watch);
    });
    if (!signal?.aborted) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {}); // the person can retry
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const how = await Promise.race([cancelled, closed, timeout]);
    clearTimeout(timer);
    return { profile, url, ended: how, profile_path: dir };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (ctx) await close();
    release();
  }
}
