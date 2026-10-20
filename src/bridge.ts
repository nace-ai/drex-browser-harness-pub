// Lets a coding agent (Claude Code, Cursor, Codex, opencode: anything that speaks MCP) use Drex. mcp/server.mjs
// listens on 127.0.0.1 and the extension's service worker connects to it while "Let coding agents use Drex" is on,
// so runs from a coding agent show up in the panel like your own, and work with the panel closed.
// The link is paired (src/pairing.ts): nothing is done for the other end until it has proved the pairing code.
// Requests are {id, method, params}; replies {id, result} or {id, error}.
import { attachable } from "./agent.ts";
import { Tab } from "./cdp.ts";
import { PAIRING_VERSION, checkProof, proof, randomToken, validCode } from "./pairing.ts";
import { dataUrl, toShot } from "./shots.ts";
import type {
  BridgeIn,
  BridgeOut,
  BridgeParams,
  BridgeState,
  EndScreen,
  LastRun,
  Problem,
  RunEvent,
  RunOver,
  RunResult,
  RunStatus,
  Who,
} from "./types.ts";
import { agentMayRead, agentRunOver } from "./agent-access.ts";

/** The worker's side of the link: what the bridge calls. run is the worker's runTask (null: no keys yet). */
export interface BridgeHost {
  run: (task: string, over: RunOver) => Promise<LastRun | null>;
  busy: () => boolean;
  agentTab: () => number | null;
  onState: (state: BridgeState) => void;
}
export interface Bridge {
  set: (value: boolean, pairing?: string) => void;
  connected: () => boolean;
}
export interface Summary {
  status: RunStatus;
  message: string | undefined;
  answer: string | undefined;
  end_page: { url: string; title: string | undefined } | undefined;
  expect: EndScreen["expect"];
  problems: Problem[];
  report_error: string | undefined;
  moves: string[];
  cost_usd: number;
  drex_moves: number;
  llm_moves: number;
  seconds: number;
  screenshot: string | null;
}
type BridgeMethod = "run" | "screenshot" | "read" | "tabs";
/** The agent's own log entries (Agent.log): a move, and a question for the person. */
type MoveEvent = RunEvent & { who: Who; what: string; effect?: string };
type AskLogEvent = RunEvent & { kind: string; message: string };

export const BRIDGE_PORT = 47615;
const RETRY_MS = 3000;
const LOAD_WAIT_MS = 15000;
const AUTH_WAIT_MS = 5000; // a server that hasn't proved the code by then is hung up on
const PING_MS = 20000; // keeps the link (and the service worker) alive between calls
// told to the planner, Drex and the helper: a coding agent wants to know what the page did, not a run that keeps
// retrying a broken page (a planted bug in e2e/site/devapp.html took 25 retries before this)
const FROM_AGENT =
  "(Asked by a coding agent. If the page doesn't respond the way the task expects after a fair try, " +
  "for example nothing happens after a button is clicked twice, don't keep retrying: give up and say exactly what the page did. For a test, that is the result.)";

/** The window a coding agent's run works in: the one you used last. */
export async function lastWindow(): Promise<chrome.windows.Window> {
  return chrome.windows.getLastFocused({ windowTypes: ["normal"] });
}

/** run(task, over): the service worker's runTask. busy(): a run is going. agentTab(): the tab the last run worked in.
 * onState(state, detail): off, waiting, pairing, connected, no-code, wrong-code, unpaired-server, impostor. */
export function createBridge({ run, busy, agentTab, onState }: BridgeHost): Bridge {
  let ws: WebSocket | null = null;
  let linked = false; // the socket is open and the server proved the code
  let on = false;
  let code = "";
  let timer: number | undefined;
  let ownTab: number | null | undefined = null; // the tab opened for the coding agent's start URLs, reused by the next run
  const seen = new Set<number>(); // the tabs the coding agent's runs opened or worked in: the only ones it may read

  async function openTab(url: string): Promise<void> {
    const win = await lastWindow();
    const old = ownTab && (await chrome.tabs.get(ownTab).catch(() => null));
    const t = old
      ? await chrome.tabs.update(old.id, { url, active: true })
      : await chrome.tabs.create({ windowId: win.id, url, active: true });
    if (!t) throw new Error("Chrome has no such tab to open the page in.");
    ownTab = t.id;
    if (t.id != null) seen.add(t.id);
    await new Promise<void>((resolve) => {
      const done = () => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(cap);
        resolve();
      };
      const onUpdated = (id: number, info: { status?: string }): void => {
        if (id === t.id && info.status === "complete") done();
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
      const cap = setTimeout(done, LOAD_WAIT_MS);
    });
  }

  // A coding agent sees only the tabs its own runs opened or worked in: the person's other tabs stay private.
  async function pickTab(id: number | undefined): Promise<number | undefined> {
    const worked = agentTab();
    if (worked != null) seen.add(worked);
    if (id != null) {
      if (!agentMayRead(id, seen))
        throw new Error(
          `Tab ${id} wasn't opened by a Drex run: Drex only shows the tabs its runs opened or worked in.`,
        );
      return id;
    }
    const last = worked ?? ownTab;
    if (last != null && (await chrome.tabs.get(last).catch(() => null))) return last;
    throw new Error("No tab from a Drex run to look at yet: start one with drex_run (give it a url).");
  }

  /** Attaches to the tab for one look and detaches again; not while a run holds the debugger. */
  async function withTab<T>(id: number | undefined, fn: (tab: Tab) => Promise<T>): Promise<T> {
    if (busy()) throw new Error("Drex is working on a task; wait for drex_run to return.");
    if (id === undefined) throw new Error("No tab undefined."); // a tab without an id: what the lookup below made of undefined
    const info = await chrome.tabs.get(id).catch(() => null);
    if (!info) throw new Error(`No tab ${id}.`);
    if (!attachable(info.url)) throw new Error(`Drex can't look at ${info.url}.`);
    const tab = new Tab(id);
    tab.overlay = false;
    await tab.attach();
    try {
      return await fn(tab);
    } finally {
      await tab.detach();
    }
  }

  async function shoot(tab: Tab): Promise<string> {
    let jpeg: string;
    try {
      jpeg = await tab.screenshot();
    } catch (e) {
      if (!String((e as { message?: unknown }).message).includes("timed out")) throw e;
      await chrome.tabs.update(tab.id, { active: true }); // Chrome doesn't paint a hidden tab: bring it to the front
      jpeg = await tab.screenshot();
    }
    return dataUrl(await toShot(jpeg, await tab.viewport()));
  }

  const methods: Record<BridgeMethod, (params: BridgeParams) => Promise<unknown>> = {
    async run({ task, url, expect, plan }) {
      if (!task) throw new Error("No task given.");
      if (busy()) throw new Error("Drex is already working on a task in this browser; wait for it to finish.");
      if (url) await openTab(url);
      const r = await run(`${task}\n${FROM_AGENT}`, agentRunOver(expect, plan));
      const worked = agentTab();
      if (worked != null) seen.add(worked);
      if (!r) throw new Error("Drex has no API keys yet: add them in the panel's settings.");
      return summary(r);
    },
    async screenshot({ tab_id }) {
      const id = await pickTab(tab_id);
      return withTab(id, async (tab) => {
        const [title, url] = (await tab.eval("[document.title, location.href]")) as [string, string];
        return { tab_id: id, url, title, screenshot: await shoot(tab) };
      });
    },
    async read({ tab_id }) {
      const id = await pickTab(tab_id);
      return withTab(id, async (tab) => ({ tab_id: id, ...(await tab.info()) }));
    },
    async tabs() {
      const worked = agentTab();
      if (worked != null) seen.add(worked);
      const tabs = await chrome.tabs.query({ windowId: (await lastWindow()).id });
      return tabs
        .filter((t) => t.id != null && agentMayRead(t.id, seen) && attachable(t.url))
        .map((t) => ({ tab_id: t.id, title: t.title, url: t.url, active: t.active }));
    },
  };

  function connect(): void {
    if (!on || ws) return;
    if (!validCode(code)) {
      onState("no-code");
      return;
    }
    const sock = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}`);
    ws = sock;
    let paired = false;
    let serverNonce = "";
    let ping: number | undefined;
    let failed: BridgeState | "" = ""; // why this connection ended, when it was refused
    const clientNonce = randomToken();
    const send = (m: BridgeOut): void => {
      if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(m));
    };
    const hangUp = (state: BridgeState): void => {
      failed = state;
      sock.close();
    };
    const authTimer = setTimeout(() => !paired && hangUp("impostor"), AUTH_WAIT_MS);
    sock.onopen = () => onState("pairing");
    sock.onmessage = async (m: MessageEvent<string>) => {
      let msg: BridgeIn;
      try {
        msg = JSON.parse(m.data) as BridgeIn;
      } catch {
        return;
      }
      if (!paired) {
        // before the server has proved the code, only the handshake counts: no request is ever run
        if (msg.type === "challenge" && typeof msg.nonce === "string") {
          send({
            type: "auth",
            v: PAIRING_VERSION,
            nonce: clientNonce,
            proof: await proof(code, "extension", msg.nonce, clientNonce),
            name: "drex-browser",
            version: chrome.runtime.getManifest().version,
          });
          serverNonce = msg.nonce;
        } else if (msg.type === "welcome" && serverNonce) {
          if (!(await checkProof(code, "server", serverNonce, clientNonce, msg.proof))) {
            hangUp("impostor");
            return;
          }
          paired = true;
          linked = true;
          clearTimeout(authTimer);
          ping = setInterval(() => {
            send({ type: "ping" });
          }, PING_MS);
          onState("connected");
        } else if (msg.type === "denied") {
          hangUp(
            msg.reason === "unpaired-server"
              ? "unpaired-server"
              : msg.reason === "wrong-code"
                ? "wrong-code"
                : "impostor",
          );
        }
        return;
      }
      if (msg.type === "pong") return;
      const { id, params } = msg;
      const method = String(msg.method);
      let out: BridgeOut;
      try {
        if (!Object.hasOwn(methods, method)) throw new Error(`Unknown method ${method}.`);
        out = { id, result: await methods[method as BridgeMethod](params ?? {}) };
      } catch (e) {
        out = { id, error: (e as Error).message || String(e) };
      }
      send(out);
    };
    sock.onclose = () => {
      clearTimeout(authTimer);
      clearInterval(ping);
      if (ws === sock) {
        ws = null;
        linked = false;
      }
      onState(!on ? "off" : failed || "waiting");
      // a refused pairing is retried more slowly: the server or the code has to change first
      if (on) timer = setTimeout(connect, failed ? RETRY_MS * 4 : RETRY_MS);
    };
  }

  return {
    /** value: on or off; pairing: the code (a new code drops the current link and pairs again). */
    set(value: boolean, pairing = code) {
      const changed = pairing !== code;
      on = value;
      code = pairing || "";
      clearTimeout(timer);
      if (!on || changed) ws?.close();
      if (on && !changed) connect();
      if (on && changed && !ws) connect();
      if (!on) onState("off");
      else if (!validCode(code)) onState("no-code");
    },
    connected: () => linked,
  };
}

/** What a coding agent gets back: the outcome, what each move did, the end screen and the page errors seen. */
export function summary(r: RunResult): Summary {
  const moves: string[] = [];
  for (const e of r.record) {
    if (e.type === "move") {
      const mv = e as MoveEvent;
      moves.push(`${mv.who === "drex" ? "Drex" : "LLM"}: ${mv.what}${mv.effect ? ` -> ${mv.effect}` : ""}`);
    } else if (e.type === "ask") {
      const ask = e as AskLogEvent;
      moves.push(`asked the person at the browser (${ask.kind}): ${ask.message}`);
    }
  }
  const t = r.totals;
  const rep: Partial<EndScreen> & { error?: string; problems?: Problem[] } = r.report ?? {};
  return {
    status: r.status,
    message: r.message || undefined,
    answer: r.answer || undefined,
    end_page: rep.url ? { url: rep.url, title: rep.title } : undefined,
    expect: rep.expect,
    problems: rep.problems ?? [],
    report_error: rep.error,
    moves,
    cost_usd: +(t.drexUsd + t.llmUsd).toFixed(5),
    drex_moves: t.drexMoves,
    llm_moves: t.llmMoves,
    seconds: +t.seconds.toFixed(1),
    screenshot: rep.screenshot || null,
  };
}
