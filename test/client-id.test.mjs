import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Drex } from "../src/drex.ts";
import { checkDrexKey } from "../src/keycheck.ts";
import { NACE_CLIENT } from "../src/client-id.ts";
import { modelTransport } from "../runner/src/worker-transport.mjs";
import { naceClient } from "../runner/src/version.mjs";

const pkg = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), "utf8"));
// Drex splits at the first "/" and checks each part against its character set (lib/request-client.ts)
const FORMAT = /^[A-Za-z0-9 ._@+-]+\/[A-Za-z0-9 ._@+-]+$/;
const okBody = () =>
  new Response(JSON.stringify({ model: "drex-max", answers: { done: { noul: 0.6 } }, usage: { input_tokens: 12 } }));
const header = (headers, name) => new Headers(headers).get(name);

test("the client id is name/version from package.json, in the format Drex accepts", () => {
  const { version } = pkg("../package.json");
  assert.equal(NACE_CLIENT, `drex-browser-harness/${version}`);
  assert.match(NACE_CLIENT, FORMAT);
  assert.ok(NACE_CLIENT.length <= 64);
  // the runner is its own package: it must name the same release
  assert.equal(pkg("../runner/package.json").version, version);
  assert.equal(naceClient(), NACE_CLIENT);
});

test("the extension's Drex calls send X-Nace-Client", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    seen.push(init.headers);
    return okBody();
  });
  await new Drex({ key: "fixture" }).ask("state", { done: { type: "noul", instructions: "Task is done." } });
  await checkDrexKey("fixture");
  assert.equal(seen.length, 2);
  for (const headers of seen) assert.equal(header(headers, "x-nace-client"), NACE_CLIENT);
});

test("the runner's Drex calls send X-Nace-Client and User-Agent, and its LLM calls neither", async (t) => {
  const seen = {};
  t.mock.method(globalThis, "fetch", async (url, init) => {
    seen[new URL(url).hostname] = init.headers;
    return okBody();
  });
  const transport = modelTransport({ drexUrl: "https://drex.example", llmUrl: "https://llm.example", drexKey: "k" });
  for (const url of ["https://console.nace.ai/v1/systemone", "https://api.anthropic.com/v1/messages"])
    await transport({ url, method: "POST", body: "{}" });
  assert.equal(seen["drex.example"]["x-nace-client"], naceClient());
  assert.equal(seen["drex.example"]["user-agent"], naceClient());
  assert.equal(seen["llm.example"]["x-nace-client"], undefined);
  assert.equal(seen["llm.example"]["user-agent"], undefined);
});
