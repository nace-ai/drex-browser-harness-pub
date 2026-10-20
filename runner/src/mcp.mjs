// `nace-browser mcp`: the runner as an MCP server over stdio, for coding agents. Three tools:
//   browser_task      runs one task on a saved profile and returns the result (the /v1/browser/runs shape);
//   browser_login     opens a window for a person to sign in, and returns when it is closed;
//   browser_profiles  lists the saved profiles.
// The risky-click guard is always enabled here: --allow-risky is a person's choice on the command line, not an agent's.
// An agent may lower the run limits, never raise them. NACE_BROWSER_HEADED=1 shows the browser window.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_LIMITS, UsageError, checkUrl, limitsOf, profileOf } from "./args.mjs";
import { login } from "./login.mjs";
import { DEFAULT_PROFILE, listProfiles } from "./profiles.mjs";
import { errorOf } from "./result.mjs";
import { codeOf, runTask } from "./run.mjs";
import { version } from "./version.mjs";

const json = (value, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
  ...(isError ? { isError: true } : {}),
});
const failure = (e) => json(errorOf(e instanceof UsageError ? "invalid_request" : codeOf(e), e.message), true);

/**
 * The server, with its tools registered. deps replaces the run, login and env in tests. handleSignals: false when the
 * caller handles SIGTERM itself (`nace-browser mcp` cancels the running tools); see run.mjs's launch().
 */
export function createServer({ env = process.env, run = runTask, signIn = login, handleSignals = true } = {}) {
  const server = new McpServer({ name: "nace-browser", version: version() });

  server.registerTool(
    "browser_task",
    {
      title: "Browser task",
      description:
        "Do a task in a real browser (Chromium on this machine) and return the result: an answer in answer_text, " +
        "the outcome, the steps and the cost. Use it for web pages that need clicking, typing or reading behind " +
        "navigation, including sites signed in to with browser_login. It can change or delete site data. " +
        "A best-effort click guard stops recognized risky clicks with outcome risky_action_denied, but cannot " +
        "prevent every payment, send, deletion or order (for example, forms submitted with Enter). " +
        "Use only for tasks and accounts where the person authorizes those effects. A sign-in or CAPTCHA ends it " +
        "blocked_login or blocked_captcha: ask the person to run browser_login. Runs take seconds to minutes.",
      inputSchema: {
        task: z.string().min(1).max(4000).describe("What to do, in plain words, with the answer you want back."),
        start_url: z.string().describe("The http(s) page the run starts on."),
        profile: z
          .string()
          .optional()
          .describe(`The saved browser profile (default "${DEFAULT_PROFILE}"). See browser_profiles.`),
        max_cost_usd: z
          .number()
          .positive()
          .max(DEFAULT_LIMITS.maxCostUsd)
          .optional()
          .describe(
            `Stop at this model cost (at most ${DEFAULT_LIMITS.maxCostUsd}; by default the model's own limit).`,
          ),
        max_seconds: z
          .number()
          .int()
          .positive()
          .max(DEFAULT_LIMITS.maxSeconds)
          .optional()
          .describe(`Stop after this many seconds (default and most ${DEFAULT_LIMITS.maxSeconds}).`),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        const opts = {
          task: args.task.trim(),
          url: checkUrl(args.start_url, "start_url"),
          profile: profileOf(args.profile),
          headed: env.NACE_BROWSER_HEADED === "1",
          // an agent lowers the limits; it can't raise them (the zod schema caps each at its default)
          limits: limitsOf({ maxCost: args.max_cost_usd, maxSeconds: args.max_seconds }, DEFAULT_LIMITS),
          allowRisky: false,
        };
        if (!opts.task) throw new UsageError("task is empty.");
        const token = extra._meta?.progressToken;
        let n = 0;
        const onProgress = (message) => {
          if (token === undefined) return;
          extra
            .sendNotification({
              method: "notifications/progress",
              params: { progressToken: token, progress: ++n, message },
            })
            .catch(() => {});
        };
        return json(await run(opts, { env, onProgress, signal: extra.signal, handleSignals }));
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "browser_login",
    {
      title: "Browser sign-in",
      description:
        "Open a visible browser window on a saved profile so the person at this computer can sign in to a site. " +
        "Returns when they close the window (at most 15 minutes). Later browser_task runs on that profile are " +
        "signed in. Call it when a run ended blocked_login, and tell the person what to do in the window.",
      inputSchema: {
        url: z.string().describe("The http(s) page to sign in on."),
        profile: z.string().optional().describe(`The profile to keep the session in (default "${DEFAULT_PROFILE}").`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        const url = checkUrl(args.url, "url");
        const profile = profileOf(args.profile);
        return json(await signIn({ url, profile }, { env, signal: extra.signal, handleSignals }));
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    "browser_profiles",
    {
      title: "Browser profiles",
      description: "List the saved browser profiles: name, path, whether a run is using it, and when it was last used.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => json({ profiles: listProfiles(env) }),
  );

  return server;
}

/** Serves on stdio until the client hangs up. deps: createServer's, and stdin/stdout in tests. */
export async function serve({ stdin = process.stdin, stdout = process.stdout, ...deps } = {}) {
  const server = createServer(deps);
  await server.connect(new StdioServerTransport(stdin, stdout));
  // the client hung up: the transport doesn't close on stdin's end, so close it here, which cancels the running tools
  // (their browsers close and their profile locks are released)
  const hangUp = () => void server.close().catch(() => {});
  stdin.once("end", hangUp);
  stdin.once("close", hangUp);
  return server;
}
