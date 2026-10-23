# Drex Browser Use worker (maintainer notes)

> [!NOTE]
> **For maintainers.** Cloud runs are not available yet. This page documents the `drex-browser-run` entry and its
> sandbox build, which are in this repository for that future service; users of the CLI, the MCP server or the
> extension never need it.

`drex-browser-run` is the cloud entry in the same `@nace-ai/browser` package as
`nace-browser`. It calls `runTask`; there is no copied planner or browser agent.
The package and E2B candidate are not automatically published or enabled.

## Local CLI and MCP stay local

Use `nace-browser run`, `nace-browser login` and `nace-browser mcp` as before
(see [the runner guide](runner.md)). They launch local Chromium directly and
require no E2B account, template, API key or Drex Browser Use API callback.
`drex-browser-run` is the separate cloud entrypoint. Running that entrypoint
locally below is only an integration test for the cloud protocol, not the
normal local workflow. E2B is a template-builder dependency, not a dependency
of the installed `@nace-ai/browser` package.

## Protocol and worker integration testing

Drex owns the normalized JSON schema. Import it from a committed checkout with
`node scripts/sync-browser-protocol.mjs /path/to/drex`. `runner/protocol/source.json`
records its commit and checksum. Changes belong in Drex first.

The entry reads `DREX_PROTOCOL_VERSION=2`, `DREX_RUN_ID`, `DREX_RUN_SPEC`,
`DREX_CALLBACK_URL`, `DREX_CALLBACK_SECRET`, `DREX_BASE_URL` and the optional
`LLM_BASE_URL` (default `https://api.anthropic.com`). Both base URLs are bare
origins: the worker calls `/v1/systemone` and `/v1/messages` on them and refuses
a path prefix. The callback must be `/api/webhooks/browser-runs` on the Drex origin.
With a valid run id, callback key and callback URL, any refused configuration
(protocol version, spec, origins, start URL, a base URL with a path) is reported
as `internal_error` ("Browser worker refused its configuration.") before the
entry exits 1; otherwise nothing can be reported and Drex times the run out.
`DREX_EXPECTED_WORKER_SHA`, when provided, requires a matching clean package.
The current worker uses the default Anthropic model (`DEFAULT_MODEL`), the one
Drex pins LLM prices for: a funded call naming any other model is refused, so
changing it needs matching Drex prices. The LLM URL must implement
the Anthropic messages API. Switching to another provider is not implemented.

After `npm ci && npm run build:release`, package with `npm pack -w runner`.
Install that tarball in a clean directory and run its `drex-browser-run` bin
with the environment above. For a local instance, Node reads `DREX_API_KEY`
and `ANTHROPIC_API_KEY`; neither reaches Chromium. `DREX_WORKER_ALLOW_LOCAL=1`
allows local fixtures: HTTP Drex/LLM/callback URLs, origins with ports or
non-public names, and private addresses in the browser proxy. Do not set it in
the E2B template; it is not a run-spec field or public API option.

One run uses a fresh temporary profile. The worker deletes its local result
files and profile after execution. Artifact URLs are empty until a separate
artifact-storage integration exists; filesystem paths are never presented as
customer-accessible URLs. `answer_schema` is added to the task's requested output
format; the resulting JSON is passed to Drex, which validates it and owns
`answer_invalid` and billing. The task also lists the run's `allowed_origins`, so
the agent knows any other address is blocked.

## Network boundary

Only the extension worker uses a private extension port to its runner-owned
extension page. That page alone exposes two Playwright bindings to Node: one
accepts only the two model operations, never arbitrary destination URLs or
headers; the other only cancels such a call, by its id, when its port closes (and every call in flight is cancelled when the extension page closes). Node performs the request; in E2B, the egress proxy inserts provider
credentials. The extension receives placeholders and responses. Chromium's
processes start without the worker's `DREX_*`, `E2B_*`, `*_API_KEY`, secret or
token variables. A model call has no fixed timeout of its own: the extension
times it against the run budget, and the run deadline or the funded budget's
deadline ends it.

Chromium uses a per-run proxy that allows only exact declared HTTP(S) origins,
including redirects and CONNECT destinations. Hosts are compared without a
trailing dot. DNS addresses are pinned and private/reserved addresses are rejected. QUIC and non-proxied WebRTC are
disabled; page service workers and WebSockets are blocked. This may prevent
sites relying on those features from working. The page network path cannot
reach the credential-injected model or callback hosts.

The existing risky-action guard remains a **heuristic**, not a general
guarantee against business writes: unrecognized controls, Enter, or a site's
GET endpoint can have effects. Do not enable a public API promising stronger
`deny` semantics until that product/security boundary is resolved. Controlled
MiniWoB fixtures do not establish safety on arbitrary sites.

## Callback and limits

One finished event is signed using the run-specific Standard Webhooks key.
Network errors and 5xx retry with the same event ID/body for at most 30 seconds
(a funded run's report: only within its remaining funded lifetime, see "Funded
execution"); 4xx stop. Each request has at most 5 seconds. Browser execution has its run
deadline (`max_seconds` from the worker's start; the extension's own budget ends
5 seconds before it, after the browser's start-up, and is never under 1 second,
so its result can still be read and reported), and E2B's outer TTL is
the final cleanup bound. Drex owns settlement,
cancellation and sandbox cleanup. Heartbeats remain optional and are not sent.
No provider exception or secret is printed by the worker entry.

The harness enforces its existing model-spend/call/time budgets. Through the
worker's model transport, a complete refusal (a 4xx other than 408, or
Anthropic's 529; a 529 from Drex is treated as a 5xx) bills nothing: its reservation is released and the extension
may retry it. Any other uncertain result (no answer at all, a lost transport, a
cut-off or oversized reply, a 408 or other 5xx that a gateway may return after
the provider did billed work, or a 2xx without complete usage) keeps its
reservation and stops the run; see "Funded execution". Its model price estimate is not Drex's
customer bill, which also includes browser time.

## E2B candidate

Commit and validate the candidate, then run `node sandbox/build.mjs` to prepare
the context. It packs the same npm package used locally and writes a locked
runtime install, Dockerfile and release manifest under `.worker-releases/SHA/`.
The base Node image is pinned by digest; Playwright/Chromium come from the
package's pinned dependency.

`E2B_API_KEY=… node sandbox/build.mjs --build` creates the test candidate in the
selected E2B team. No credentials are copied into its build context. The
manifest includes source SHA, package/lock checksums, template ID and build ID.
Each build attempt uses a new alias containing the source SHA and a random suffix, so another CI runner cannot overwrite an earlier candidate. Once a local manifest records a built template, the builder refuses to replace it. Use that unique alias with `BROWSER_WORKER_SHA` in Drex and verify the
actual E2B build ID before selecting it. Do not reassign an existing release
alias to different content. Keep the previous manifest for rollback; on the
first release the rollback is to stop admissions and retain cleanup/callback
configuration for existing runs. The manifest also records `protocol_version`:
a worker accepts only its own protocol version, so Drex's protocol version and
the selected `BROWSER_WORKER_SHA` change together, and rolling back to a v1
template also needs Drex to send v1 (or to stop admissions). A v1 worker has no
funded boundary, so stopping admissions is the safer rollback.

Before enabling the feature, test actual API → sandbox → browser → signed
callback → settlement → kill on a reachable test environment. A manually
replayed callback is not that test. Validate duplicate delivery, cancellation,
timeouts and cleanup failures. Use the same package checksum locally and in
E2B. Public enablement, retention/SDK rollout dependencies and deployment
approval remain separate from a successful closed test.

The E2B entrypoint sets `NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/e2b-ca.crt`, the CA E2B installs at sandbox boot. This lets Node verify the credential-injecting proxy without disabling TLS verification.

The entrypoint also sets `PLAYWRIGHT_BROWSERS_PATH=/opt/browsers` explicitly: E2B command sessions did not inherit the build-time Docker `ENV` values in the live smoke.

## Funded execution

Protocol v2 requires Drex's funding envelope `spec.funding`: `budget_nusd`
(integer nano-USD ceiling, as a decimal string), `started_at_ms` (sandbox
billing start) and `expires_at_ms` (grant expiry), both epoch milliseconds, and
pinned customer rates `prices.drex_input`, `prices.llm_input`, `prices.llm_output`
(nano-USD per token) and `prices.browser_second` (nano-USD per started second).
Node reserves every physical provider request before sending it, including
retries, using a conservative input bound and maximum output: a Drex Max call
must use `drex-max` with at least one question and holds 262,144 tokens per
question; an LLM call holds its UTF-8 body bytes, a
framing allowance and a pixel bound for each PNG, JPEG or WebP image in a
message's or tool result's content (its header must give both sides, each at
most 20,000 pixels; an image block in any other format, or with an unreadable header, is refused; base64 outside an image block counts as text), plus `max_tokens` (at
most 4096). An LLM call must name the worker's model, the one the LLM prices
are pinned for, may have no top-level fields other than those the extension
sends (so no MCP servers, container, model fallbacks, speed, service tier,
region, compaction or context management), and may not use server tools, URL and
file sources, or a document other than plain text (PDFs and content documents
are billed by pages and pixels its bytes do not bound). A request outside these bounds is refused before it is
sent and holds nothing: the extension gets a transport error and the run continues. A request the remaining funds
cannot cover is a budget stop. Sandbox
time uses the same budget. The remaining funds and `expires_at_ms` determine an
AbortSignal deadline for in-flight calls and the browser, alongside `max_seconds`.
Ten sandbox seconds of funds, and the last ten seconds before `expires_at_ms`,
are kept back for cleanup and the report. The report is sent and retried only
within what is left of that funded lifetime (a 1-second window when nothing is
left, so Drex hears of the run and stops the sandbox), not for the full
30-second delivery window. An uncertain provider response retains its
reservation and stops the run. No provider request is reserved or sent after
that signal, and Chromium is closed at once, without asking the agent to stop or
reading its result and end screen. A hosted run never takes the end screenshot: the report carries no artifacts.

The finished event's `data` adds `budget_exhausted` and `resource_bound_nusd`
(decimal nano-USD string: settled usage, still-held reservations and elapsed
sandbox seconds), taken after cleanup and before the report is sent: the
seconds spent sending the report are not in it. When no funds are left, that
1-second report window is Nace's control-plane overhead, never resumed provider
work or customer usage debt. `usage` is the provider-reported usage Node metered; LLM input
includes cache read and creation tokens. A budget stop reports
`outcome.kind: "limit_reached"` with `budget_exhausted: true`; Drex cancels the
whole request free and releases its wallet hold once. A call the budget stop
itself cuts off keeps its reservation in `resource_bound_nusd` and stays a
budget stop. `limit_reached` with `budget_exhausted: false` is a run limit
(`max_seconds` with no provider call in flight, or the extension's own time,
cost or LLM-call limit), not the funded ceiling. An unconfirmed provider
outcome reports `internal_error` with `budget_exhausted: false`, its reservation
included in `resource_bound_nusd`. That includes a call still in flight when
`max_seconds`, a Drex cancellation, the extension's own run limits or the end of the run cuts it off: the
outcome is then `internal_error`, not `limit_reached` or `cancelled`. Usage
above a call's reservation is a budget stop. A refused configuration's report
has neither funding field. The operational guard still counts consumed
resources. The extension's local USD budget does not authorize hosted spending.
Protocol v1 configurations are refused before any provider work; deploying this
package and selecting its verified worker SHA is a separate rollout step. No E2B
template or package is published by this change.

An extension request abort or port disconnect cancels its Node provider fetch. An uncertain receipt retains its reservation and stops the funded run, so cancellation cannot turn into a free physical retry. The pinned prices are customer tariff rates, not provider acquisition costs; provider cache/tier multipliers do not change Drex settlement.

The funded clock advances monotonically even if the local wall clock moves back.
A start timestamp ahead of the worker clock stops the run before provider work as a
budget stop (`limit_reached`, `budget_exhausted: true`), which Drex cancels free.
When the runner enters cleanup, new provider calls are refused and cleanup can
use its reserved seconds. The full grant deadline still stops cleanup funding: reached during cleanup, it is a
budget stop (`limit_reached`, `budget_exhausted: true`) even after a completed run;
Drex's own sandbox duration and the wallet ceiling remain authoritative at settlement.
