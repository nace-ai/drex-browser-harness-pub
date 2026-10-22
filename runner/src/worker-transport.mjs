import { providerUsage } from "./hosted-budget.mjs";
// The extension gets an in-process RPC channel, never provider credentials or a
// localhost HTTP proxy. Only its service worker can open this extension port;
// only the runner's extension page has the Playwright binding back to Node.
const PORT = "nace-worker-fetch";
const MAX_RESPONSE = 8 * 1024 * 1024;

export function modelTransport({ drexUrl, llmUrl, drexKey = "proxy", llmKey = "proxy", signal, budget }) {
  const endpoints = new Map([
    ["https://console.nace.ai/v1/systemone", { url: new URL("/v1/systemone", drexUrl), key: drexKey, kind: "drex" }],
    ["https://api.anthropic.com/v1/messages", { url: new URL("/v1/messages", llmUrl), key: llmKey, kind: "llm" }],
  ]);
  return async (request) => {
    const endpoint = endpoints.get(request.url);
    if (
      !endpoint ||
      request.method !== "POST" ||
      typeof request.body !== "string" ||
      request.body.length > 16 * 1024 * 1024
    )
      throw new Error("Worker transport refused this operation.");
    const headers = { "content-type": "application/json" };
    if (endpoint.kind === "drex") headers.authorization = `Bearer ${endpoint.key}`;
    else {
      headers["x-api-key"] = endpoint.key;
      headers["anthropic-version"] = "2023-06-01";
      const beta = request.headers?.["anthropic-beta"];
      if (typeof beta === "string" && /^[a-zA-Z0-9,._-]{1,1000}$/.test(beta)) headers["anthropic-beta"] = beta;
    }
    const ticket = budget?.reserve(endpoint.kind, JSON.parse(request.body));
    let response;
    try {
      response = await fetch(endpoint.url, {
        method: "POST",
        headers,
        body: request.body,
        redirect: "error",
        // no fixed cap: the extension streams long replies and times each call against its own run budget
        signal,
      });
    } catch (error) {
      if (ticket) budget.settle(ticket, null);
      if (signal?.aborted || budget?.signal.aborted) throw error;
      // no answer at all: the one failure the extension may retry as an unbilled connection error
      return { unanswered: true };
    }
    const reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    let bodyError = false;
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_RESPONSE) throw new Error("Model response exceeded the worker limit.");
          chunks.push(Buffer.from(value));
        }
      } catch {
        // Headers arrived: keep this a broken reply, never an unsent request.
        bodyError = true;
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    if (ticket)
      budget.settle(
        ticket,
        response.ok && !bodyError ? providerUsage(endpoint.kind, Buffer.concat(chunks).toString("utf8")) : null,
      );
    return {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
      body: bodyError ? "" : Buffer.concat(chunks).toString("base64"),
      bodyError,
    };
  };
}

/** Page requests never use the model transport. Every page/worker/pop-up is
 * restricted to exact origins; page service workers cannot bypass routing. */
export async function restrictPages(ctx, origins) {
  const allowed = new Set(origins);
  const permitted = (value) => {
    try {
      return allowed.has(new URL(value).origin);
    } catch {
      return false;
    }
  };
  await ctx.route("**/*", (route) =>
    permitted(route.request().url()) ? route.continue() : route.abort("blockedbyclient"),
  );
  await ctx.routeWebSocket("**/*", (socket) => socket.close());
}

export async function connectTransport(panel, worker, transport) {
  await panel.exposeBinding("__naceWorkerFetch", async ({ page, frame }, request) => {
    if (page !== panel || frame !== panel.mainFrame() || !panel.url().startsWith("chrome-extension://"))
      throw new Error("Untrusted transport caller.");
    return transport(request);
  });
  await panel.evaluate((name) => {
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== name || port.sender?.id !== chrome.runtime.id) return;
      // Keep the MV3 worker alive while Node buffers a model's streamed reply.
      const ping = setInterval(() => port.postMessage({ ping: true }), 10000);
      port.onDisconnect.addListener(() => clearInterval(ping));
      port.onMessage.addListener(async (request) => {
        try {
          const result = await globalThis.__naceWorkerFetch(request);
          port.postMessage(result.unanswered ? { error: "Model connection failed.", unanswered: true } : { result });
        } catch {
          // Never relay an SDK exception that might include provider headers.
          try {
            port.postMessage({ error: "Model transport failed." });
          } catch {}
        }
      });
    });
  }, PORT);
  await worker.evaluate((name) => {
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url.startsWith(`chrome-extension://${chrome.runtime.id}/`)) return original(input, init);
      const body = await request.text();
      return new Promise((resolve, reject) => {
        const port = chrome.runtime.connect({ name });
        let finished = false;
        const end = (error, response) => {
          if (finished) return;
          finished = true;
          request.signal.removeEventListener("abort", abort);
          port.disconnect();
          if (error) reject(error);
          else resolve(response);
        };
        const abort = () => end(new DOMException("Request aborted", "AbortError"));
        // a TypeError only when no answer came back, as fetch's own network failure: the extension retries those as
        // unbilled. Anything later (a cut reply, the size cap, a lost panel) may have been billed: a plain Error, whose
        // cost the extension counts as unknown
        port.onDisconnect.addListener(() => end(new Error("Model transport disconnected")));
        port.onMessage.addListener((message) => {
          if (message.ping) return;
          if (message.error) return end(message.unanswered ? new TypeError(message.error) : new Error(message.error));
          const { status, headers, body, bodyError } = message.result;
          // LLM retries classify fetch TypeErrors as unbilled. Chrome can turn an errored Response body into
          // TypeError("Failed to fetch"), so keep this known answered failure plain for the LLM transport.
          if (bodyError && request.url === "https://api.anthropic.com/v1/messages")
            return end(new Error("Model response was cut off after headers"));
          try {
            end(
              null,
              new Response(
                [204, 205, 304].includes(status)
                  ? null
                  : bodyError
                    ? new ReadableStream({
                        start: (c) => c.error(new Error("Model response was cut off after headers")),
                      })
                    : Uint8Array.from(atob(body), (c) => c.charCodeAt(0)),
                { status, headers },
              ),
            );
          } catch {
            // answered, so possibly billed: never a retryable TypeError
            end(new Error("Model response could not be read"));
          }
        });
        request.signal.addEventListener("abort", abort, { once: true });
        if (request.signal.aborted) return abort();
        port.postMessage({
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body,
        });
      });
    };
  }, PORT);
}
