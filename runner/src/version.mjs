import fs from "node:fs";

/** The package's version, from its package.json (one place to bump). */
export const version = () => JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** What Drex sees in X-Nace-Client and User-Agent on the runner's own calls: `name/version`, at most 64 characters
 * from [A-Za-z0-9 ._@+-]. The extension's copy is src/client-id.ts. */
export const naceClient = () => `drex-browser-harness/${version()}`;
