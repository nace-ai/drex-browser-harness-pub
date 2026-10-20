import fs from "node:fs";

/** The package's version, from its package.json (one place to bump). */
export const version = () => JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
