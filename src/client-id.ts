import pkg from "../package.json" with { type: "json" };

// How Drex tells this project's traffic from other integrations: `name/version`, sent as X-Nace-Client on every call
// to the Drex API. The version is package.json's (the one place to bump); the runner has its own copy of the same
// rule in runner/src/version.mjs, and test/client-id.test.mjs keeps the two equal. Drex drops a value over 64
// characters or with characters outside [A-Za-z0-9 ._@+-].
export const NACE_CLIENT = `drex-browser-harness/${pkg.version}`;
export const NACE_CLIENT_HEADER = "X-Nace-Client";
