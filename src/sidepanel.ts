// The side panel: the task box, the live cost meter, the plan, every move, and the questions the agent asks. The
// runs themselves happen in the service worker (background.ts), so they go on when this panel is closed; the panel
// connects to it, shows the run so far, and sends Run, Stop and your answers.
import { checkDrexKey, LLM_KEY_CHECKS } from "./keycheck.ts";
import { MODELS, MODEL_NAMES, PRICES, PROVIDERS, providerOf, providerOfKey } from "./models.ts";
import { agentSetups, newCode, validCode } from "./pairing.ts";
import { loadSettings, missingKey } from "./settings.ts";
import type {
  AskEvent,
  Prices,
  Settings,
  BridgeState,
  LastRun,
  PlanLike,
  PanelMessage,
  Totals,
  UserAnswer,
  WorkerMessage,
} from "./types.ts";

/** The element with this id, which must be a `type`: a wrong id or tag throws here, with the id, instead of at the first use. */
const $ = <T extends Element>(id: string, type: new () => T): T => {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`#${id} is missing or not a ${type.name}`);
  return el;
};
/** A part of a row this file built itself. */
const part = (row: Element, selector: string): Element => {
  const found = row.querySelector(selector);
  if (!found) throw new Error(`${selector} is missing from the row`);
  return found;
};
const PURPOSE: Record<string, string> = {
  plan: "made the plan",
  read: "read the page and wrote",
  rescue: "took over one move",
  write: "wrote the text Drex types next",
  verify: "checked the step on screen",
  look: "looked at the screen",
  ready: "checked the screen before a click that can't be undone",
  collect: "read the list",
  fill: "worked out the form's values",
};
const BUSY: Record<string, string> = {
  plan: "LLM is planning",
  read: "LLM is reading the page",
  rescue: "LLM is helping Drex",
  write: "LLM is writing the text to type",
  verify: "LLM is checking the step",
  look: "LLM is looking at the screen",
  ready: "LLM is checking before the click",
  collect: "LLM is reading the list",
  fill: "LLM is working out the form",
};
let running = false;
let pendingDrex: { p?: number; ms?: number } | null = null; // the Drex decision whose move is about to be logged
let liveTabId: number | null = null; // the agent's tab, for "Show tab"
let port: chrome.runtime.Port;
let bridgePaths: { server?: string; node?: string } = {}; // {server, node}: mcp/server.mjs and node on this machine, from the build (dist/bridge.local.json)

/** The prices of an offered model: MODELS are the keys of PRICES. */
const priceOf = (model: string): Prices => {
  const prices = PRICES[model];
  if (!prices) throw new Error(`No prices for ${model}`);
  return prices;
};
/** A call whose cost is unknown arrives as null (agent.ts); formatting it threw a TypeError before and still throws, kept on purpose. */
const usd = (v: number | null): string => {
  if (v === null) throw new Error("The cost of this call is unknown");
  return `$${v < 0.01 ? v.toFixed(5) : v.toFixed(4)}`;
};
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

// --- settings -------------------------------------------------------------------------------------------------------
/** What the toggles may hold in storage: a switch an older build never saved is missing (it counts as on, `bridge` as off). */
type Switches = Partial<Pick<Settings, "background" | "approvals" | "notify" | "cursor" | "planning" | "bridge">>;
async function showSettings(): Promise<void> {
  const s: Omit<Settings, keyof Switches> & Switches = await loadSettings();
  $("drexKey", HTMLInputElement).value = s.drexKey || "";
  // one LLM key field: it shows the key of the chosen model's provider, and the models that key can use
  $("llmKey", HTMLInputElement).value = s[PROVIDERS[providerOf(s.model)].keyName] || "";
  showLLMKey(s.model);
  $("background", HTMLInputElement).checked = s.background !== false;
  $("approvals", HTMLInputElement).checked = s.approvals !== false;
  $("notify", HTMLInputElement).checked = s.notify !== false;
  $("cursor", HTMLInputElement).checked = s.cursor !== false;
  $("planning", HTMLInputElement).checked = s.planning !== false;
  $("bridge", HTMLInputElement).checked = !!s.bridge;
  $("llmName", HTMLElement).textContent = MODEL_NAMES[s.model] || "LLM";
  showPairing(s.bridgeCode);
}

// The pairing code and how to add the MCP server with it to the coding agent picked (remembered in this browser), shown
// while the coding-agent switch is on
function showPairing(code: string | undefined): void {
  $("pairing", HTMLDivElement).hidden = !$("bridge", HTMLInputElement).checked;
  const setups = validCode(code)
    ? agentSetups(code ?? "", { server: bridgePaths.server || undefined, node: bridgePaths.node || undefined })
    : [];
  if (!$("agent", HTMLSelectElement).options.length) {
    $("agent", HTMLSelectElement).innerHTML = agentSetups("x")
      .map((s) => `<option value="${s.id}">${s.label}</option>`)
      .join("");
    try {
      $("agent", HTMLSelectElement).value = localStorage.getItem("drexAgent") || "claude";
    } catch {}
    if (!$("agent", HTMLSelectElement).value) $("agent", HTMLSelectElement).value = "claude"; // a remembered agent that's no longer listed
  }
  const setup = setups.find((s) => s.id === $("agent", HTMLSelectElement).value);
  $("setupHow", HTMLParagraphElement).textContent = setup?.how || "";
  $("setupCmd", HTMLElement).textContent = setup?.text || "";
  $("addToCursor", HTMLAnchorElement).hidden = !setup?.link;
  if (setup?.link) $("addToCursor", HTMLAnchorElement).href = setup.link;
}
async function pickAgent(): Promise<void> {
  try {
    localStorage.setItem("drexAgent", $("agent", HTMLSelectElement).value);
  } catch {}
  showPairing((await chrome.storage.local.get<{ bridgeCode?: string }>("bridgeCode")).bridgeCode);
}
$("agent", HTMLSelectElement).onchange = () => void pickAgent();

async function switchBridge(): Promise<void> {
  let { bridgeCode } = await chrome.storage.local.get<{ bridgeCode?: string }>("bridgeCode");
  if ($("bridge", HTMLInputElement).checked && !validCode(bridgeCode)) {
    bridgeCode = newCode();
    await chrome.storage.local.set({ bridgeCode });
  }
  showPairing(bridgeCode);
}
$("bridge", HTMLInputElement).onchange = () => void switchBridge();
$("copySetup", HTMLButtonElement).onclick = () =>
  void navigator.clipboard.writeText($("setupCmd", HTMLElement).textContent).then(() => {
    $("copySetup", HTMLButtonElement).textContent = "Copied";
    setTimeout(() => ($("copySetup", HTMLButtonElement).textContent = "Copy"), 1500);
  });
// a new code unpairs every MCP server set up with the old one
$("newCode", HTMLButtonElement).onclick = () => void chrome.storage.local.set({ bridgeCode: newCode() });

async function toggleSettings(): Promise<void> {
  await showSettings();
  $("settings", HTMLElement).hidden = !$("settings", HTMLElement).hidden;
}
$("gear", HTMLButtonElement).onclick = () => void toggleSettings();
/** The provider the LLM key field holds a key of, the models that key can use, and `keep` chosen when it's one of them. */
function showLLMKey(keep: string): void {
  const provider = providerOfKey($("llmKey", HTMLInputElement).value) || providerOf(keep);
  const known = Boolean(providerOfKey($("llmKey", HTMLInputElement).value));
  $("llmKeyKind", HTMLElement).textContent = !$("llmKey", HTMLInputElement).value.trim()
    ? "Anthropic, OpenAI, Google Gemini, OpenRouter or Fireworks"
    : known
      ? `${PROVIDERS[provider].label} key`
      : "Not a key we know: Anthropic, OpenAI, Google Gemini, OpenRouter or Fireworks";
  const models = MODELS.filter((m) => providerOf(m) === provider);
  $("model", HTMLSelectElement).innerHTML = models
    .map((m) => `<option value="${m}">${MODEL_NAMES[m]} ($${priceOf(m)[0]} / $${priceOf(m)[1]} per M tokens)</option>`)
    .join("");
  $("model", HTMLSelectElement).value = models.includes(keep) ? keep : PROVIDERS[provider].defaultModel;
}
$("llmKey", HTMLInputElement).addEventListener("input", () => showLLMKey($("model", HTMLSelectElement).value));

// the keys as typed (saved or not): a key that's rejected, an LLM account with no credits, or a Drex key without Drex
// Max shows here in seconds
async function checkKeys(): Promise<void> {
  const out = $("keyCheck", HTMLParagraphElement);
  out.hidden = false;
  out.dataset.ok = "";
  out.textContent = "Checking the keys...";
  const llmKey = $("llmKey", HTMLInputElement).value.trim(),
    provider = providerOfKey(llmKey);
  const [drex, llm] = await Promise.all([
    checkDrexKey($("drexKey", HTMLInputElement).value.trim()),
    provider
      ? LLM_KEY_CHECKS[provider](llmKey, $("model", HTMLSelectElement).value)
      : { ok: false, message: llmKey ? "Not a key we know." : "No key." },
  ]);
  out.dataset.ok = String(drex.ok && llm.ok);
  out.textContent = `Drex: ${drex.message}\n${provider ? PROVIDERS[provider].label : "LLM"}: ${llm.message}`;
}
$("checkKeys", HTMLButtonElement).onclick = () => void checkKeys();

async function saveSettings(): Promise<void> {
  // the LLM key goes under its provider (keys of other providers stay as they were)
  const llmKey = $("llmKey", HTMLInputElement).value.trim(),
    provider = providerOfKey(llmKey);
  if (llmKey && !provider) {
    setStatus(
      "That LLM key isn't one we know: use an Anthropic, OpenAI, Google Gemini, OpenRouter or Fireworks key.",
      "bad",
    );
    return;
  }
  await chrome.storage.local.set({
    drexKey: $("drexKey", HTMLInputElement).value.trim(),
    model: $("model", HTMLSelectElement).value,
    ...(provider ? { [PROVIDERS[provider].keyName]: llmKey } : {}),
    background: $("background", HTMLInputElement).checked,
    approvals: $("approvals", HTMLInputElement).checked,
    notify: $("notify", HTMLInputElement).checked,
    cursor: $("cursor", HTMLInputElement).checked,
    planning: $("planning", HTMLInputElement).checked,
    bridge: $("bridge", HTMLInputElement).checked,
  });
  $("llmName", HTMLElement).textContent = MODEL_NAMES[$("model", HTMLSelectElement).value] ?? "";
  $("settings", HTMLElement).hidden = true;
}
$("saveSettings", HTMLButtonElement).onclick = () => void saveSettings();

// --- running ----------------------------------------------------------------------------------------------------------
function setStatus(text: string, cls = ""): void {
  $("statusText", HTMLSpanElement).textContent = text;
  $("status", HTMLParagraphElement).className = `status ${cls}`;
}

function setRunning(on: boolean): void {
  $("run", HTMLButtonElement).hidden = on;
  $("stop", HTMLButtonElement).hidden = !on;
  $("task", HTMLTextAreaElement).disabled = on;
}

function reset(): void {
  for (const id of ["plan", "log", "asks"]) $(id, HTMLElement).innerHTML = "";
  $("answer", HTMLElement).hidden = true;
  $("planBox", HTMLElement).hidden = true;
  $("live", HTMLElement).hidden = true;
  liveTabId = null;
  $("logBox", HTMLElement).hidden = true;
  $("download", HTMLButtonElement).disabled = true;
  pendingDrex = null;
  setStatus("Ready");
  updateTotals({
    drexUsd: 0,
    llmUsd: 0,
    drexCalls: 0,
    llmCalls: 0,
    drexMoves: 0,
    llmMoves: 0,
    drexItems: 0,
    seconds: 0,
  });
}

async function submitTask(e: SubmitEvent): Promise<void> {
  e.preventDefault();
  const task = $("task", HTMLTextAreaElement).value.trim();
  if (!task || running) return;
  const s = await loadSettings();
  if (missingKey(s)) return askForKeys();
  port.postMessage({ type: "run", task, windowId: (await chrome.windows.getCurrent()).id } satisfies PanelMessage);
}
$("taskForm", HTMLFormElement).onsubmit = (e) => void submitTask(e);

async function askForKeys(): Promise<void> {
  await showSettings();
  $("settings", HTMLElement).hidden = false;
  const s = await loadSettings();
  const which = missingKey(s);
  setStatus(
    which === "Drex"
      ? "Add your Drex key first."
      : `Add an LLM key first: ${which ? `a ${which} key for ${MODEL_NAMES[s.model] || s.model}, or ` : ""}any Anthropic, OpenAI, Google Gemini, OpenRouter or Fireworks key.`,
    "bad",
  );
}

$("task", HTMLTextAreaElement).addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("taskForm", HTMLFormElement).requestSubmit();
});
$("stop", HTMLButtonElement).onclick = () => {
  port.postMessage({ type: "stop" } satisfies PanelMessage);
};
$("showTab", HTMLButtonElement).onclick = () =>
  void (liveTabId && chrome.tabs.update(liveTabId, { active: true }).catch(() => undefined));
$("copy", HTMLButtonElement).onclick = () =>
  void navigator.clipboard.writeText($("answerText", HTMLPreElement).textContent);
$("download", HTMLButtonElement).onclick = () => {
  port.postMessage({ type: "lastRun" } satisfies PanelMessage);
};

function download(run: LastRun | null): void {
  if (!run) return;
  const blob = new Blob([JSON.stringify(run, null, 1)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `drex-run-${run.started.replace(/[:.]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// --- events from the agent ------------------------------------------------------------------------------------------
function updateTotals(t: Omit<Totals, "waitSeconds">): void {
  $("totalUsd", HTMLSpanElement).textContent = usd(t.drexUsd + t.llmUsd);
  $("drexUsd", HTMLElement).textContent = usd(t.drexUsd);
  $("llmUsd", HTMLElement).textContent = usd(t.llmUsd);
  $("drexMoves", HTMLSpanElement).textContent = String(t.drexMoves);
  $("drexItems", HTMLSpanElement).textContent = t.drexItems ? `, ${t.drexItems} items` : "";
  $("llmCalls", HTMLSpanElement).textContent = String(t.llmCalls);
  $("share", HTMLElement).textContent = "";
  $("secs", HTMLElement).textContent = `${t.seconds.toFixed(1)} s`;
}

// Who did it, as the console's badges: Drex solid, the LLM outlined
function badge(who: "LLM" | "Drex" | "Every item"): HTMLSpanElement;
function badge(who: string): HTMLSpanElement | null;
function badge(who: string): HTMLSpanElement | null {
  if (!who) return null;
  const b = document.createElement("span");
  b.className = `badge ${who === "Drex" ? "solid" : "outline"}`;
  b.textContent = who;
  return b;
}

function addRow(cls: string, who: string, what: string, meta = "", why = ""): void {
  $("logBox", HTMLElement).hidden = false;
  const li = document.createElement("li");
  li.className = cls;
  li.innerHTML = `<span class="who"></span><span class="what"></span><span class="meta"></span>`;
  const b = badge(who);
  if (b) part(li, ".who").append(b);
  part(li, ".what").textContent = what;
  part(li, ".meta").textContent = meta;
  if (why) {
    const w = document.createElement("span");
    w.className = "why";
    w.textContent = why;
    part(li, ".what").append(w);
  }
  const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
  $("log", HTMLOListElement).append(li);
  if (atBottom) li.scrollIntoView({ block: "nearest" });
}

function renderPlan(plan: PlanLike): void {
  $("planBox", HTMLElement).hidden = false;
  $("plan", HTMLOListElement).innerHTML = "";
  if (!plan.steps) throw new Error("The plan has no steps."); // the agent logs the plan before it checks for steps, so this was a TypeError
  plan.steps.forEach((s, i) => {
    const li = document.createElement("li");
    li.id = `step-${i}`;
    li.innerHTML = `<span class="n"></span><span><span class="kind"></span><span class="goal"></span></span>`;
    part(li, ".n").textContent = String(i + 1).padStart(2, "0");
    part(li, ".kind").append(badge(s.kind === "read" ? "LLM" : "Drex"));
    if (s.kind === "batch")
      part(li, ".kind").append(" ", Object.assign(badge("Every item"), { className: "badge outline" }));
    part(li, ".goal").textContent = s.goal ?? "";
    $("plan", HTMLOListElement).append(li);
  });
}

function showAsk(e: Omit<AskEvent, "items"> & { items?: string[] | null; image?: string | null }): void {
  const card = document.createElement("div");
  card.className = "panel ask";
  const title = document.createElement("p");
  title.className = "ask-title";
  title.textContent = e.kind === "approve" ? "Approval needed" : "Your turn";
  const p = document.createElement("p");
  p.className = "ask-text";
  p.textContent = e.message;
  card.append(title, p);
  if (e.items?.length) {
    const ul = document.createElement("ul");
    ul.className = "ask-items";
    for (const text of e.items) {
      const li = document.createElement("li");
      li.textContent = text;
      li.title = text;
      ul.append(li);
    }
    card.append(ul);
  }
  if (e.image) {
    const img = document.createElement("img");
    img.src = e.image;
    card.append(img);
  }
  const row = document.createElement("div");
  row.className = "actions";
  const button = (text: string, value: UserAnswer, primary = false) => {
    const b = document.createElement("button");
    b.textContent = text;
    b.className = `btn ${primary ? "primary" : "outline"}`;
    b.onclick = () => {
      port.postMessage({ type: "answer", value } satisfies PanelMessage);
    };
    return b;
  };
  if (e.kind === "approve")
    row.append(button("Stop", false), button("Allow once", "once"), button("Allow for this task", "always", true));
  else row.append(button("Stop", false), button("I'm done, continue", true, true));
  card.append(row);
  $("asks", HTMLElement).replaceChildren(card);
  setStatus(e.kind === "approve" ? "Waiting for your approval" : "Waiting for you", "busy");
}

/** The agent's events as the panel reads them (agent.ts logs them; the worker passes them on without their screen thumbnail). */
function onEvent(type: string, data: Record<string, unknown>): void {
  switch (type) {
    case "plan": {
      const e = data as { plan: PlanLike; replanned?: boolean; why?: string };
      renderPlan(e.plan);
      if (e.plan.direct) addRow("sys", "", "No LLM plan: Drex works on your task as you wrote it.");
      if (e.replanned) addRow("llm", "LLM", "changed the plan", "", e.why);
      break;
    }
    case "step": {
      const e = data as { index: number; status: string };
      document.getElementById(`step-${e.index}`)?.classList.remove("running", "done", "failed");
      document.getElementById(`step-${e.index}`)?.classList.add(e.status);
      break;
    }
    case "busy": {
      const e = data as { who: string; purpose: string };
      setStatus(
        e.who === "drex" ? "Drex is choosing the next move" : BUSY[e.purpose] || "LLM is working",
        `busy ${e.who}`,
      );
      break;
    }
    case "decision":
      pendingDrex = data;
      break;
    case "move": {
      const e = data as { who: string; what: string; changed?: boolean; p?: number; ms?: number; effect?: string };
      if (e.who === "drex") {
        const d = pendingDrex;
        pendingDrex = null;
        addRow(
          `drex${e.changed === false ? " nochange" : ""}`,
          "Drex",
          e.what,
          `${Math.round((e.p ?? d?.p ?? 0) * 100)}% · ${secs(e.ms ?? d?.ms ?? 0)}`,
          e.effect ? `→ ${e.effect}` : "",
        );
      } else {
        addRow(`llm${e.changed === false ? " nochange" : ""}`, "LLM", e.what, "", e.effect ? `→ ${e.effect}` : "");
      }
      break;
    }
    case "llm": {
      const e = data as { purpose: string; ms: number; usd: number | null };
      addRow("llm", "LLM", PURPOSE[e.purpose] || e.purpose, `${secs(e.ms)} · ${usd(e.usd)}`);
      break;
    }
    case "rescue": {
      const e = data as { about: string; reason: string; why?: string; decision?: string };
      pendingDrex = null;
      addRow(
        "sys",
        "",
        e.about === "finish"
          ? "Drex asked the LLM whether the task is finished"
          : e.about === "risky"
            ? "Before a click that can't be undone, the LLM checks the screen against your task"
            : `Drex asked for help: ${e.reason}`,
        "",
        e.why
          ? `LLM${e.about === "finish" ? (e.decision === "finished" ? " (finished)" : " (not yet)") : ""}: ${e.why}`
          : "",
      );
      break;
    }
    case "note": {
      const e = data as { name: string; text: string };
      addRow("llm", "LLM", `wrote "${e.name}" (${e.text.length} characters)`);
      $("answerText", HTMLPreElement).textContent = e.text;
      $("answer", HTMLElement).hidden = false;
      break;
    }
    case "tab":
    case "tick":
      addRow("sys", "", (data as { what: string }).what);
      break;
    case "loop": {
      const e = data as { moves: string[] };
      addRow("sys", "", `Loop noticed: ${e.moves.join(" → ")}. Those moves are paused and the LLM takes the next one.`);
      break;
    }
    case "batch": {
      const e = data as {
        counts: Record<string, number>;
        items: number;
        calls: number;
        ms: number;
        usd: number | null;
        unsure?: number;
      };
      const counts = Object.entries(e.counts)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ");
      addRow(
        "drex",
        "Drex",
        `decided ${e.items} items in ${e.calls} call${e.calls > 1 ? "s" : ""}: ${counts}`,
        `${secs(e.ms)} · ${usd(e.usd)}`,
        e.unsure ? `${e.unsure} unsure, opening ${e.unsure > 1 ? "them" : "it"} to decide` : "",
      );
      break;
    }
    case "ask":
      showAsk(data as typeof data & Omit<AskEvent, "items"> & { items?: string[] | null; image?: string | null });
      break;
    case "answer":
      $("asks", HTMLElement).innerHTML = "";
      break;
    case "skipped":
      addRow("sys", "", `Not asked (approvals are off): ${(data as { what: string }).what}`);
      break;
    case "totals":
      updateTotals(data as typeof data & Totals);
      break;
    case "aim": {
      const e = data as { fx: number; fy: number };
      $("liveCursor", SVGElement).style.left = `${(e.fx * 100).toFixed(2)}%`;
      $("liveCursor", SVGElement).style.top = `${(e.fy * 100).toFixed(2)}%`;
      $("liveCursor", SVGElement).toggleAttribute("hidden", false); // an <svg> has no .hidden property: set the attribute
      break;
    }
    case "screen": {
      const e = data as { tabId: number; image: string; url: string };
      liveTabId = e.tabId;
      $("liveCursor", SVGElement).toggleAttribute("hidden", true);
      $("liveImg", HTMLImageElement).src = e.image;
      $("liveUrl", HTMLParagraphElement).textContent = e.url;
      $("live", HTMLElement).hidden = false;
      break;
    }
    case "finish": {
      const e = data as { totals: Totals; answer?: string; status: string; message: string };
      updateTotals(e.totals);
      $("asks", HTMLElement).innerHTML = "";
      if (e.answer) {
        $("answerText", HTMLPreElement).textContent = e.answer;
        $("answer", HTMLElement).hidden = false;
      }
      const t = e.totals;
      const moves = t.drexMoves + t.llmMoves;
      const done = `Done in ${t.seconds.toFixed(0)} s: ${moves} moves (${t.drexMoves} by Drex) for ${usd(t.drexUsd + t.llmUsd)}`;
      setStatus(
        e.status === "done" ? done : `${e.status === "stopped" ? "Stopped" : "Failed"}: ${e.message}`,
        e.status === "done" ? "ok" : "bad",
      );
      break;
    }
  }
}

// --- the service worker ---------------------------------------------------------------------------------------------
const BRIDGE_STATE: Record<BridgeState, string> = {
  off: "Off.",
  "no-code": "No pairing code yet: switch this on and save.",
  waiting: "Waiting for a coding agent to start the Drex MCP server.",
  pairing: "Pairing with the MCP server...",
  connected: "Paired with your Drex MCP server.",
  "wrong-code": "The MCP server has a different pairing code. Add it again with the command below.",
  "unpaired-server": "The MCP server was started without a pairing code. Add it again with the command below.",
  impostor: "Something on port 47615 failed the pairing check, so Drex takes no tasks from it.",
};

function showBridge(state: BridgeState): void {
  $("bridgeState", HTMLSpanElement).textContent = BRIDGE_STATE[state] || state;
  $("bridgeState", HTMLSpanElement).dataset.state = state;
}

function showRunning(on: boolean): void {
  running = on;
  setRunning(on);
}

/** The worker's messages: the run so far when the panel connects, then each event as it happens. */
function onWorker(message: unknown): void {
  const m = message as WorkerMessage;
  switch (m.type) {
    case "hello":
      showBridge(m.bridge);
      reset();
      if (m.run) {
        $("task", HTMLTextAreaElement).value = m.run.task;
        $("llmName", HTMLElement).textContent = MODEL_NAMES[m.run.model] || m.run.model;
        for (const [type, data] of m.run.events) onEvent(type, data);
      }
      showRunning(!!m.run?.running);
      $("download", HTMLButtonElement).disabled = !m.hasRun || !!m.run?.running;
      break;
    case "running":
      if (m.on) {
        reset();
        $("task", HTMLTextAreaElement).value = m.task;
        $("llmName", HTMLElement).textContent = MODEL_NAMES[m.model] || m.model;
      }
      showRunning(m.on);
      $("download", HTMLButtonElement).disabled = m.on || !m.hasRun;
      break;
    case "event":
      onEvent(m.event, m.data);
      break;
    case "refused":
      if (m.why === "keys") void askForKeys();
      else if (m.why === "error") setStatus(m.message, "bad");
      else setStatus("Drex is working on another task (from a coding agent?). Wait for it to finish.", "bad");
      break;
    case "bridge":
      showBridge(m.state);
      break;
    case "lastRun":
      download(m.run);
      break;
  }
}

// The worker can be stopped and started again by Chrome; the panel then connects again and gets the run so far.
function connect(): void {
  port = chrome.runtime.connect({ name: "panel" });
  port.onMessage.addListener(onWorker);
  port.onDisconnect.addListener(() => setTimeout(connect, 300));
}

connect();
void fetch(chrome.runtime.getURL("bridge.local.json"))
  .then((r) => r.json())
  .then((j) => (bridgePaths = (j as { server?: string; node?: string } | null) ?? {}))
  .catch(() => undefined)
  .finally(showSettings);
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== "local") return;
  if (c.bridgeCode) showPairing(c.bridgeCode.newValue as string | undefined);
  if (c.bridge && $("settings", HTMLElement).hidden) $("bridge", HTMLInputElement).checked = !!c.bridge.newValue;
});
if (!navigator.platform.toUpperCase().includes("MAC")) $("kbd", HTMLSpanElement).textContent = "Ctrl Enter";
