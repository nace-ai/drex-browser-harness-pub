#!/usr/bin/env node
import { runWorker } from "../src/worker.mjs";
const stop = new AbortController();
for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(name, () => stop.abort());
try {
  const event = await runWorker(process.env, { signal: stop.signal });
  console.log(JSON.stringify({ run_id: event.data.run_id, outcome: event.data.outcome.kind, delivered: true }));
} catch {
  console.error("Browser worker failed; inspect the run state in Drex.");
  process.exitCode = 1;
}
