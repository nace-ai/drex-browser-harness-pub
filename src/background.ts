// The extension's service worker. Every run happens here, from the panel's Run button or from a coding agent, so a
// run keeps going when the side panel is closed. The panel is a view: it connects with a port, gets the run so far
// and every event after it, and sends back Run, Stop and your answers. Approvals and hand-overs also come as Chrome
// notifications with buttons. The coding-agent link (bridge.ts) lives here too, paired with the MCP server.
import { Agent } from "./agent.ts";
import { createBridge, lastWindow } from "./bridge.ts";
import { Drex } from "./drex.ts";
import { LLM } from "./llm.ts";
import { LoopAgent } from "./loop/agent.ts";
import { MODE, loopMode } from "./mode.ts";
import { MODELS } from "./models.ts";
import { newCode, validCode } from "./pairing.ts";
import { limitsFrom } from "./run-budget.ts";
import { llmKeys, loadSettings, missingKey } from "./settings.ts";
import type {
  AskEvent,
  BridgeState,
  LastRun,
  PanelMessage,
  PanelRun,
  PlanLike,
  ModelId,
  RunOver,
  WorkerMessage,
} from "./types.ts";

declare global {
  // what the e2e scripts evaluate in the worker
  var drexState: () => {
    bridge: BridgeState;
    running: boolean;
    hasRun: boolean;
    status: string | null;
    panels: number;
    task: string | null;
    ask: string | null;
    agentTab: number | null;
  };
}

const NOTE_ID = "drex-ask";
const KEEPALIVE_MS = 20000; // an extension API call this often keeps the worker from being stopped mid-run
const WAKE_ALARM = "drex-bridge"; // wakes a stopped worker so the coding-agent link comes back
/** A setting is on unless it is false. */
const isOn = (v: unknown): boolean => v !== false;
const LATEST_ONLY = new Set(["screen", "aim", "totals", "busy"]); // events where only the newest matters to a panel

let agent: Agent | null = null;
let lastRun: LastRun | null = null;
let run: PanelRun | null = null; // what a panel shows: {task, model, running, events: [[type, data]...]}
let ask: AskEvent | null = null; // the question waiting for an answer
let liveTabId: number | null = null;
let notifyOn = true;
let bridgeOn = false;
let bridgeState: BridgeState = "off";
const panels = new Set<chrome.runtime.Port>();

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((e: unknown) => console.error(e));

function broadcast(msg: WorkerMessage): void {
  for (const p of panels) {
    try {
      p.postMessage(msg);
    } catch {}
  }
}

// --- one run --------------------------------------------------------------------------------------------------------
/** The event as a panel needs it: without the screen thumbnails kept for the run log (they stay in agent.record). */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Emit's data is always an object here; the guard stays as it was
const forPanel = (e: Record<string, unknown>): Record<string, unknown> => (e?.shot ? { ...e, shot: undefined } : e);

function onEvent(type: string, e: Record<string, unknown>): void {
  const data = forPanel(e);
  if (run) {
    if (LATEST_ONLY.has(type)) run.events = run.events.filter(([t]) => t !== type);
    run.events.push([type, data]);
  }
  if (type === "screen") liveTabId = e.tabId as number;
  if (type === "ask") {
    ask = e as unknown as AskEvent;
    notify(ask);
  }
  if (type === "answer" || type === "finish") {
    ask = null;
    void chrome.notifications.clear(NOTE_ID);
  }
  broadcast({ type: "event", event: type, data });
}

/** One run. over: settings this run changes ({planning, approvals}), and a coding agent's {report: {expect}}.
 * Returns the run, or null when a key is missing. */
async function runTask(
  task: string,
  over: RunOver = {},
  windowId: number | null | undefined = null,
): Promise<LastRun | null> {
  if (agent) throw new Error("Drex is already working on a task in this browser; wait for it to finish.");
  // a model named by the caller (the local runner's --model) is checked here: settings fall back to the default instead
  if (over.model !== undefined && !MODELS.includes(over.model))
    throw new Error(`Unknown model ${over.model}. Models: ${MODELS.join(", ")}.`);
  const settings = await loadSettings();
  const s = { ...settings, ...over, model: (over.model ?? settings.model) as ModelId };
  const { drexKey } = s;
  if (missingKey(s) || !drexKey) return null;
  const { testPlan } = await chrome.storage.local.get<{ testPlan?: PlanLike }>("testPlan"); // set by e2e/run.py --plan; used once
  if (testPlan) await chrome.storage.local.remove("testPlan");
  const win = windowId ?? (await lastWindow()).id;
  // the loop build (DREX_MODE=loop) runs LoopAgent; the default build runs Agent, as before
  const AgentClass = loopMode() ? LoopAgent : Agent;
  agent = new AgentClass({
    drex: new Drex({ key: drexKey }),
    llm: new LLM({ keys: llmKeys(s), model: s.model }),
    emit: onEvent,
    windowId: win,
    background: isOn(s.background),
    approvals: isOn(s.approvals),
    unattended: s.unattended, // not isOn: that reads an unset key as on
    cursor: isOn(s.cursor),
    planning: isOn(s.planning),
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- a stored falsy plan means no plan
    plan: testPlan || null,
    report: s.report ?? null,
    runOptions: { limits: limitsFrom(s.runLimits) },
  });
  run = { task, model: s.model, running: true, events: [] };
  ask = null;
  liveTabId = null;
  notifyOn = isOn(s.notify);
  lastRun = null;
  broadcast({ type: "running", on: true, task, model: s.model });
  if (over.report) onEvent("tab", { what: "Task from a coding agent" });
  keepAlive();
  try {
    lastRun = {
      task,
      model: s.model,
      planning: isOn(s.planning),
      mode: MODE,
      started: new Date().toISOString(),
      ...(await agent.run(task)),
    };
  } finally {
    agent = null;
    run.running = false;
    keepAlive();
    broadcast({ type: "running", on: false, hasRun: !!lastRun });
  }
  return lastRun;
}

// --- the panel ----------------------------------------------------------------------------------------------------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "panel" || port.sender?.id !== chrome.runtime.id) return;
  panels.add(port);
  port.onDisconnect.addListener(() => panels.delete(port));
  port.postMessage({ type: "hello", run, hasRun: !!lastRun, bridge: bridgeState } satisfies WorkerMessage);
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Chrome ignores a listener's return value
  port.onMessage.addListener(async (raw: unknown) => {
    const m = raw as PanelMessage;
    if (m.type === "run") {
      if (agent) {
        port.postMessage({ type: "refused", why: "busy" } satisfies WorkerMessage);
        return;
      }
      // over: what the local runner (runner/) sets for its run; the panel sends none. Only extension pages connect here.
      const r = await runTask(m.task, m.over ?? {}, m.windowId).catch((e: unknown) => {
        console.error(e);
        port.postMessage({ type: "refused", why: "error", message: (e as Error).message } satisfies WorkerMessage);
        return undefined;
      });
      if (r === null) port.postMessage({ type: "refused", why: "keys" } satisfies WorkerMessage);
    } else if (m.type === "stop") agent?.stop();
    else if (m.type === "answer") agent?.answer(m.value);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- a message of any other type is ignored
    else if (m.type === "lastRun") port.postMessage({ type: "lastRun", run: lastRun } satisfies WorkerMessage);
  });
});

// --- notifications ------------------------------------------------------------------------------------------------
function notify(e: AskEvent): void {
  if (!notifyOn) return;
  const title = e.kind === "approve" ? "Drex needs your approval" : "Drex needs you";
  const message = e.items?.length ? `${e.message}\n${e.items.slice(0, 3).join("\n")}` : e.message;
  const buttons =
    e.kind === "approve"
      ? [{ title: "Allow once" }, { title: "Stop" }]
      : [{ title: "I'm done, continue" }, { title: "Stop" }];
  void chrome.notifications.create(NOTE_ID, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message: message.slice(0, 300),
    requireInteraction: true,
    priority: 2,
    buttons,
  });
}

// the buttons answer without the panel: "Allow once" / "I'm done" go ahead, Stop stops
chrome.notifications.onButtonClicked.addListener((id, index) => {
  if (id !== NOTE_ID || !agent || !ask) return;
  agent.answer(index === 0 ? (ask.kind === "approve" ? "once" : true) : false);
  void chrome.notifications.clear(NOTE_ID);
});

// clicking the notification itself brings you to the run's window (and, for a hand-over, to the agent's tab, where
// the CAPTCHA or login is) and opens the panel there
// eslint-disable-next-line @typescript-eslint/no-misused-promises -- Chrome ignores a listener's return value
chrome.notifications.onClicked.addListener(async (id) => {
  if (id !== NOTE_ID) return;
  const win = agent?.windowId ?? (await lastWindow().catch(() => null))?.id;
  if (win != null) {
    chrome.windows.update(win, { focused: true }).catch(() => undefined);
    chrome.sidePanel.open({ windowId: win }).catch(() => undefined);
  }
  if (ask?.kind === "user" && liveTabId) chrome.tabs.update(liveTabId, { active: true }).catch(() => undefined);
});

// --- staying alive ----------------------------------------------------------------------------------------------------
// Chrome stops an idle service worker after 30 s; an extension API call resets that. While a run or the coding-agent
// link is on, one call every 20 s keeps the worker (and the run in it) going. The link's own pings do the same.
let keepTimer: number | null = null;
function keepAlive(): void {
  const want = !!agent || bridgeOn;
  if (want && !keepTimer) keepTimer = setInterval(() => chrome.runtime.getPlatformInfo(), KEEPALIVE_MS);
  if (!want && keepTimer) {
    clearInterval(keepTimer);
    keepTimer = null;
  }
}

// --- coding agents ----------------------------------------------------------------------------------------------------
const bridge = createBridge({
  run: (task, over) => runTask(task, over),
  busy: () => !!agent,
  agentTab: () => liveTabId,
  onState: (state) => {
    bridgeState = state;
    broadcast({ type: "bridge", state });
  },
});

/** Turns the link on or off from the settings; makes the pairing code the first time it's needed. */
async function syncBridge(): Promise<void> {
  const s = await chrome.storage.local.get<{ bridge?: boolean; bridgeCode?: string }>(["bridge", "bridgeCode"]);
  let code = s.bridgeCode;
  if (s.bridge && !validCode(code)) {
    code = newCode();
    await chrome.storage.local.set({ bridgeCode: code });
  }
  bridgeOn = !!s.bridge;
  bridge.set(bridgeOn, code ?? "");
  keepAlive();
  if (bridgeOn) void chrome.alarms.create(WAKE_ALARM, { periodInMinutes: 1 });
  else void chrome.alarms.clear(WAKE_ALARM);
}

chrome.storage.onChanged.addListener((c, area) => {
  if (area === "local" && (c.bridge ?? c.bridgeCode)) void syncBridge();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === WAKE_ALARM) void syncBridge();
});
chrome.runtime.onStartup.addListener(() => {
  void syncBridge();
});
void syncBridge();

// for the e2e scripts (Playwright evaluates this in the worker): what the worker is doing
globalThis.drexState = () => ({
  bridge: bridgeState,
  running: !!agent,
  hasRun: !!lastRun,
  status: lastRun?.status ?? null,
  panels: panels.size,
  task: run?.task || null,
  ask: ask?.kind ?? null,
  agentTab: liveTabId, // the tab of the newest screen (kept after the run ends)
});
