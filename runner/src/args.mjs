// The command line: `nace-browser <command> ...`, parsed into a plain object the commands take. No side effects here,
// so the parsing and its errors are tested without a browser.
import { parseArgs } from "node:util";
import { DEFAULT_PROFILE, checkProfileName } from "./profiles.mjs";

/**
 * The extension's own run limits (src/agent.ts): what a run gets unless the caller lowers them. The cost limit is
 * Haiku's; the extension scales it to the model's price (runCostCap), so a run sends one only when the caller set it.
 */
export const DEFAULT_LIMITS = Object.freeze({ maxCostUsd: 0.04, maxSeconds: 600, maxLlmCalls: 20 });
/** The most a person can raise them to from the CLI: the same caps as Drex's /v1/browser/runs. */
export const MAX_LIMITS = Object.freeze({ maxCostUsd: 1, maxSeconds: 1800, maxLlmCalls: 100 });

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.code = "usage";
  }
}

export const USAGE = `nace-browser: the Drex browser agent for coding agents, in a local Chromium.

Usage:
  nace-browser install [--with-deps]          download Playwright's Chromium once (--with-deps: also its Linux packages)
  nace-browser run "task" --url URL [options] run one task and print the result
  nace-browser login URL [--profile NAME]     open a window to sign in to a site; the profile keeps the session
  nace-browser profiles [--json]              list the saved profiles
  nace-browser mcp                            serve browser_task, browser_login and browser_profiles over stdio (MCP)

Run options:
  --url URL            the page the run starts on (http or https)
  --json               print the result as JSON (the shape of Drex's /v1/browser/runs) on stdout
  --headed             show the browser window (headless by default)
  --profile NAME       the browser profile to use (default "${DEFAULT_PROFILE}")
  --temp-profile       a fresh profile for this run only, deleted when it ends (sandboxes, one-off runs)
  --max-cost USD       stop at this model cost, Drex and the LLM together (default ${DEFAULT_LIMITS.maxCostUsd} for Haiku,
                       scaled to the model's price; at most ${MAX_LIMITS.maxCostUsd})
  --max-seconds N      stop after N seconds (default ${DEFAULT_LIMITS.maxSeconds}, at most ${MAX_LIMITS.maxSeconds})
  --max-llm-calls N    stop after N LLM requests (default ${DEFAULT_LIMITS.maxLlmCalls}, at most ${MAX_LIMITS.maxLlmCalls})
  --model M            the LLM that plans and reads (default claude-haiku-5-5)
  --allow-risky        disable the best-effort risky-click guard (enabled by default)
  --out DIR            where to save the run log and screenshots (default ~/.nace/browser/runs/<run id>)
  --quiet              no progress lines on stderr

Keys come from the environment: DREX_API_KEY, and the LLM's key (ANTHROPIC_API_KEY for the default model;
OPENAI_API_KEY, GOOGLE_API_KEY or GEMINI_API_KEY, OPENROUTER_API_KEY or FIREWORKS_API_KEY for others).`;

const COMMANDS = ["install", "run", "login", "profiles", "mcp", "help", "version"];

/** An http(s) URL, as the run's start page or the login page. */
export function checkUrl(value, what = "--url") {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new UsageError(`${what} must be an http or https URL, not ${JSON.stringify(value)}.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new UsageError(`${what} must be an http or https URL, not ${JSON.stringify(value)}.`);
  return u.href;
}

/**
 * One limit: a positive number, at most `max`. `integer` for counts and seconds.
 * Returns the default when the value is undefined.
 */
export function checkLimit(value, { name, fallback, max, integer = false }) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n)))
    throw new UsageError(`${name} must be a positive ${integer ? "whole number" : "number"}, not ${value}.`);
  if (n > max) throw new UsageError(`${name} may be at most ${max}.`);
  return n;
}

/**
 * The limits a run gets: the defaults, lowered (or, up to `max`, raised) by the caller. No maxCostUsd unless the
 * caller set one: the extension's default depends on the model.
 */
export function limitsOf({ maxCost, maxSeconds, maxLlmCalls }, max = MAX_LIMITS) {
  const maxCostUsd = checkLimit(maxCost, { name: "max cost", fallback: undefined, max: max.maxCostUsd });
  return {
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    maxSeconds: checkLimit(maxSeconds, {
      name: "max seconds",
      fallback: DEFAULT_LIMITS.maxSeconds,
      max: max.maxSeconds,
      integer: true,
    }),
    maxLlmCalls: checkLimit(maxLlmCalls, {
      name: "max LLM calls",
      fallback: DEFAULT_LIMITS.maxLlmCalls,
      max: max.maxLlmCalls,
      integer: true,
    }),
  };
}

/** A profile name (the default one for none), or a UsageError. */
export function profileOf(value) {
  try {
    return checkProfileName(value ?? DEFAULT_PROFILE);
  } catch (e) {
    throw new UsageError(e.message);
  }
}

/** argv without node and the script: ["run", "task", "--url", "https://..."]. */
export function parseCli(argv) {
  const [first, ...rest] = argv;
  if (first === undefined || first === "--help" || first === "-h" || first === "help") return { command: "help" };
  if (first === "--version" || first === "-v" || first === "version") return { command: "version" };
  if (!COMMANDS.includes(first)) throw new UsageError(`Unknown command ${JSON.stringify(first)}.\n\n${USAGE}`);
  const options = {
    install: { "with-deps": { type: "boolean" } },
    run: {
      url: { type: "string" },
      json: { type: "boolean" },
      headed: { type: "boolean" },
      profile: { type: "string" },
      "temp-profile": { type: "boolean" },
      "max-cost": { type: "string" },
      "max-seconds": { type: "string" },
      "max-llm-calls": { type: "string" },
      model: { type: "string" },
      "allow-risky": { type: "boolean" },
      out: { type: "string" },
      quiet: { type: "boolean" },
    },
    login: { profile: { type: "string" } },
    profiles: { json: { type: "boolean" } },
    mcp: {},
  }[first];
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: { ...options, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    throw new UsageError(`${e.message}\n\n${USAGE}`);
  }
  const { values: v, positionals: pos } = parsed;
  if (v.help) return { command: "help" };
  const extra = (allowed) => {
    if (pos.length > allowed)
      throw new UsageError(`Unexpected argument ${JSON.stringify(pos[allowed])}. Quote the task as one argument.`);
  };
  switch (first) {
    case "install":
      extra(0);
      return { command: "install", withDeps: !!v["with-deps"] };
    case "run": {
      extra(1);
      const task = (pos[0] ?? "").trim();
      if (!task) throw new UsageError('run needs a task: nace-browser run "what to do" --url https://...');
      if (task.length > 4000) throw new UsageError("The task may be at most 4,000 characters.");
      if (!v.url) throw new UsageError("run needs --url, the page the task starts on.");
      if (v.profile !== undefined && v["temp-profile"])
        throw new UsageError("--profile and --temp-profile can't be used together.");
      return {
        command: "run",
        task,
        url: checkUrl(v.url),
        json: !!v.json,
        headed: !!v.headed,
        profile: v["temp-profile"] ? null : profileOf(v.profile),
        tempProfile: !!v["temp-profile"],
        limits: limitsOf({ maxCost: v["max-cost"], maxSeconds: v["max-seconds"], maxLlmCalls: v["max-llm-calls"] }),
        model: v.model || undefined,
        allowRisky: !!v["allow-risky"],
        out: v.out || undefined,
        quiet: !!v.quiet,
      };
    }
    case "login": {
      extra(1);
      const url = pos[0];
      if (!url) throw new UsageError("login needs the URL of the site to sign in to.");
      return { command: "login", url: checkUrl(url, "The login URL"), profile: profileOf(v.profile) };
    }
    case "profiles":
      extra(0);
      return { command: "profiles", json: !!v.json };
    case "mcp":
      extra(0);
      return { command: "mcp" };
    default:
      return { command: first };
  }
}
