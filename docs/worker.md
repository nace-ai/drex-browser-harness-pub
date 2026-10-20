# Drex browser worker (maintainer notes)

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
require no E2B account, template, API key or Drex Browser API callback.
`drex-browser-run` is the separate cloud entrypoint. Running that entrypoint
locally below is only an integration test for the cloud protocol, not the
normal local workflow. E2B is a template-builder dependency, not a dependency
of the installed `@nace-ai/browser` package.

## Protocol and worker integration testing

Drex owns the normalized JSON schema. Import it from a committed checkout with
`node scripts/sync-browser-protocol.mjs /path/to/drex`. `runner/protocol/source.json`
records its commit and checksum. Changes belong in Drex first.

The entry reads `DREX_PROTOCOL_VERSION=1`, `DREX_RUN_ID`, `DREX_RUN_SPEC`,
`DREX_CALLBACK_URL`, `DREX_CALLBACK_SECRET`, `DREX_BASE_URL` and the optional
`LLM_BASE_URL` (default `https://api.anthropic.com`). Both base URLs are bare
origins: the worker calls `/v1/systemone` and `/v1/messages` on them and refuses
a path prefix. The callback must be `/api/webhooks/browser-runs` on the Drex origin.
With a valid run id, callback key and callback URL, any refused configuration
(protocol version, spec, origins, start URL, a base URL with a path) is reported
as `internal_error` ("Browser worker refused its configuration.") before the
entry exits 1; otherwise nothing can be reported and Drex times the run out.
`DREX_EXPECTED_WORKER_SHA`, when provided, requires a matching clean package.
The current worker uses the default Anthropic model; the LLM URL must implement
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
extension page. That page alone exposes a Playwright binding to Node. The
binding accepts only the two model operations, never arbitrary destination URLs
or headers. Node performs the request; in E2B, the egress proxy inserts provider
credentials. The extension receives placeholders and responses. Chromium's
processes start without the worker's `DREX_*`, `E2B_*`, `*_API_KEY`, secret or
token variables. A model call has no fixed timeout of its own: the extension
times it against the run budget, and the run deadline ends it.

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
Network errors and 5xx retry with the same event ID/body for at most 30 seconds;
4xx stop. Each request has at most 5 seconds. Browser execution has its run
deadline (`max_seconds` from the worker's start; the extension's own budget ends
5 seconds before it, after the browser's start-up, and is never under 1 second,
so its result can still be read and reported), and E2B's outer TTL is
the final cleanup bound. Drex owns settlement,
cancellation and sandbox cleanup. Heartbeats remain optional and are not sent.
No provider exception or secret is printed by the worker entry.

The harness enforces its existing model-spend/call/time budgets. Through the
worker's model transport, an LLM call (`/v1/messages`) is retried as unbilled
only when it got no answer at all; a cut-off or oversized reply, or a lost
transport, counts as an unknown cost and ends the run as `limit_reached`. A Drex
call (`/v1/systemone`) that fails before a response, including a lost transport,
is released and retried as unbilled, as the extension's Drex client does for any
failed request; only a cut-off or oversized 2xx Drex reply counts as an unknown
cost. Its model
price estimate is not Drex's customer bill, which also includes browser time.
This change does not promise a new provider-spend guarantee.

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
configuration for existing runs.

Before enabling the feature, test actual API → sandbox → browser → signed
callback → settlement → kill on a reachable test environment. A manually
replayed callback is not that test. Validate duplicate delivery, cancellation,
timeouts and cleanup failures. Use the same package checksum locally and in
E2B. Public enablement, retention/SDK rollout dependencies and deployment
approval remain separate from a successful closed test.

The E2B entrypoint sets `NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/e2b-ca.crt`, the CA E2B installs at sandbox boot. This lets Node verify the credential-injecting proxy without disabling TLS verification.

The entrypoint also sets `PLAYWRIGHT_BROWSERS_PATH=/opt/browsers` explicitly: E2B command sessions did not inherit the build-time Docker `ENV` values in the live smoke.
