import test from "node:test";
import assert from "node:assert/strict";
import { Drex, WrongModel } from "../src/drex.ts";
import { RunBudget } from "../src/run-budget.ts";
import {
  checkAnthropicKey,
  checkDrexKey,
  checkFireworksKey,
  checkGoogleKey,
  checkOpenAIKey,
  checkOpenRouterKey,
} from "../src/keycheck.ts";

// prod answers a model the key can't use with its default model (HTTP 200, "model": "drex-v2.0"), not an error
const questions = { done: { type: "noul", instructions: "Task is done." } };
const answer = (model) =>
  new Response(JSON.stringify({ model, answers: { done: { noul: 0.6 } }, usage: { input_tokens: 12 } }));

test("an answer from another model stops the call at once, with what the key gets", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return answer("drex-v2.0");
  });
  const drex = new Drex({ key: "fixture" });
  drex.runBudget = new RunBudget();
  await assert.rejects(
    () => drex.ask("state", questions),
    (e) => e instanceof WrongModel && /gets drex-v2\.0, not Drex Max/.test(e.message),
  );
  assert.equal(calls, 1);
  assert.ok(drex.runBudget.spentUsd > 0); // the answer was billed, so it's counted
});

// with screenshots, the same key gets an error instead: HTTP 422 "images: images require drex-max"
test("a 422 'images require drex-max' says the key has no Drex Max, without retrying", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: "images: images require drex-max" } }),
      { status: 422 },
    );
  });
  await assert.rejects(
    () => new Drex({ key: "fixture" }).ask("state", questions, ["data:image/png;base64,aW1n"]),
    (e) => e instanceof WrongModel && /can't use Drex Max/.test(e.message) && /images require drex-max/.test(e.message),
  );
  assert.equal(calls, 1);
});

test("Drex Max's own answer, and an answer that names no model, go through", async (t) => {
  for (const model of ["drex-max", undefined]) {
    t.mock.method(globalThis, "fetch", async () => answer(model));
    const r = await new Drex({ key: "fixture" }).ask("state", questions);
    assert.equal(r.answers.done.noul, 0.6);
  }
});

test("checking a Drex key says whether it gets Drex Max", async () => {
  const fake = (status, body) => async () => new Response(JSON.stringify(body), { status });
  assert.deepEqual(await checkDrexKey("k", fake(200, { model: "drex-max", answers: {} })), {
    ok: true,
    message: "Works with Drex Max.",
  });
  const other = await checkDrexKey("k", fake(200, { model: "drex-v2.0", answers: {} }));
  assert.equal(other.ok, false);
  assert.match(other.message, /gets drex-v2\.0, not Drex Max/);
  const bad = await checkDrexKey("k", fake(401, { error: { message: "Invalid API key." } }));
  assert.equal(bad.ok, false);
  assert.match(bad.message, /rejected/);
  assert.deepEqual(await checkDrexKey("", fake(200, {})), { ok: false, message: "No key." });
});

test("checking an Anthropic key costs nothing (token count) and says whether it works", async () => {
  let seen;
  const ok = await checkAnthropicKey("k", "claude-haiku-5-5", async (url, init) => {
    seen = { url, init };
    return new Response('{"input_tokens":3}');
  });
  assert.deepEqual(ok, { ok: true, message: "Works." });
  assert.match(seen.url, /\/v1\/messages\/count_tokens$/);
  assert.equal(seen.init.headers["x-api-key"], "k");
  const bad = await checkAnthropicKey(
    "k",
    "claude-haiku-5-5",
    async () => new Response('{"error":{"message":"invalid x-api-key"}}', { status: 401 }),
  );
  assert.equal(bad.ok, false);
  assert.match(bad.message, /rejected/);
});

// an OpenAI key can list models while its account has no credits: the check makes one tiny call to see that
test("checking an OpenAI or Fireworks key makes one tiny call and names an empty balance", async () => {
  const fake = (status, body) => async (url, init) => {
    fake.seen = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify(body), { status });
  };
  assert.deepEqual(await checkOpenAIKey("k", "gpt-5.4-mini", fake(200, { status: "completed" })), {
    ok: true,
    message: "Works.",
  });
  assert.match(fake.seen.url, /api\.openai\.com\/v1\/responses$/);
  assert.equal(fake.seen.body.model, "gpt-5.4-mini");
  const broke = await checkOpenAIKey(
    "k",
    "gpt-5.4-mini",
    fake(429, { error: { code: "credit_balance_exhausted", message: "You have no credits remaining." } }),
  );
  assert.equal(broke.ok, false);
  assert.match(broke.message, /no credits/i);
  assert.deepEqual(
    await checkFireworksKey("k", "accounts/fireworks/models/glm-5p3-flash", fake(200, { choices: [] })),
    { ok: true, message: "Works." },
  );
  assert.match(fake.seen.url, /api\.fireworks\.ai\/inference\/v1\/chat\/completions$/);
  const bad = await checkFireworksKey("k", "m", fake(401, { error: { message: "unauthorized" } }));
  assert.equal(bad.ok, false);
  assert.match(bad.message, /rejected/);
});

test("checking a Gemini key sends it as x-goog-api-key; an OpenRouter key goes as a bearer token", async () => {
  let seen;
  const fake = (status) => async (url, init) => {
    seen = { url, init };
    return new Response("{}", { status });
  };
  assert.deepEqual(await checkGoogleKey("AIzaK", "gemini-3.1-flash-lite", fake(200)), { ok: true, message: "Works." });
  assert.match(seen.url, /models\/gemini-3\.1-flash-lite:generateContent$/);
  assert.equal(seen.init.headers["x-goog-api-key"], "AIzaK");
  assert.equal(seen.init.headers.Authorization, undefined);
  assert.equal((await checkGoogleKey("AIzaK", "m", fake(403))).ok, false);
  assert.deepEqual(await checkOpenRouterKey("sk-or-K", "z-ai/glm-5.3-flash", fake(200)), {
    ok: true,
    message: "Works.",
  });
  assert.match(seen.url, /openrouter\.ai\/api\/v1\/chat\/completions$/);
  assert.equal(seen.init.headers.Authorization, "Bearer sk-or-K");
});
