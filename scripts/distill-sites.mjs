// Condenses browser-harness's per-site guides (agent-workspace/domain-skills/<site>/*.md, MIT, Browser Use) into
// short tips for this agent: planner tips (useful URLs and deep links) and screen tips (where things are, traps),
// with the URL prefixes each guide applies to. The guides are written for coding agents (selectors, JS, scraping
// APIs); everything of that kind is dropped. Writes src/sites.json, which the extension bundles.
//
// Usage: node scripts/distill-sites.mjs /path/to/browser-harness
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (!root) throw new Error("usage: node scripts/distill-sites.mjs /path/to/browser-harness");
const dir = path.join(root, "agent-workspace", "domain-skills");
const env = Object.fromEntries(
  fs
    .readFileSync(".env", "utf8")
    .split("\n")
    .filter((l) => /^\w+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 4 });
const MODEL = "claude-haiku-5-5";
const CONCURRENCY = 8;
const MAX_GUIDE_CHARS = 60000;

const SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    url_prefixes: { type: "array", items: { type: "string" } },
    names: { type: "array", items: { type: "string" } },
    planner_tips: { type: "string" },
    screen_tips: { type: "string" },
  },
  required: ["name", "url_prefixes", "names", "planner_tips", "screen_tips"],
  additionalProperties: false,
};

const SYSTEM = `You condense a website guide that was written for coding agents into tips for a different agent, which works the site like a person: it looks at the screen, clicks and types. A planner writes its steps and the URLs to open.

Return:
- name: the site's usual name (e.g. "Gmail", "Google Sheets", "Amazon").
- url_prefixes: where the tips apply, as host or host+path without protocol or "www." (e.g. "mail.google.com", "docs.google.com/spreadsheets", "amazon.com").
- names: words a user might use for this site in a task, lowercase (e.g. "gmail", "google mail"). Avoid generic words like "email", "shop" or "news".
- planner_tips: at most 4 short plain sentences for the planner: URLs and URL patterns that open the right page directly (search URLs, deep links, filters as query parameters), and what needs a login.
- screen_tips: at most 4 short plain sentences for the agent on screen: where controls are, traps (a key that does something unexpected, a dialog that stacks, a field that only commits on blur), and how to tell an action worked.

Keep only facts about the website itself. Drop code, CSS selectors, JavaScript, API or JSON endpoints meant for scraping, rate limits for scripts, and anything about the harness that wrote the guide. If the guide has nothing useful for a person-like agent, return empty strings for the tips.`;

async function distill(site) {
  const files = fs
    .readdirSync(path.join(dir, site), { recursive: true })
    .filter((f) => f.endsWith(".md"))
    .sort();
  let text = files.map((f) => `--- ${f} ---\n${fs.readFileSync(path.join(dir, site, f), "utf8")}`).join("\n\n");
  if (text.length > MAX_GUIDE_CHARS) text = `${text.slice(0, MAX_GUIDE_CHARS)}\n[guide cut here]`;
  const r = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    messages: [{ role: "user", content: `Guide folder: ${site}\n\n${text}` }],
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
  });
  if (r.stop_reason === "refusal") throw new Error(`${site}: declined`);
  const out = JSON.parse(
    r.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(""),
  );
  return { key: site, ...out, usage: r.usage };
}

const sites = fs
  .readdirSync(dir)
  .filter((d) => fs.statSync(path.join(dir, d)).isDirectory())
  .sort();
const results = [];
let next = 0;
let tokensIn = 0;
let tokensOut = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < sites.length) {
      const site = sites[next++];
      try {
        const r = await distill(site);
        tokensIn += r.usage.input_tokens;
        tokensOut += r.usage.output_tokens;
        delete r.usage;
        results.push(r);
        process.stdout.write(".");
      } catch (e) {
        console.error(`\n${site}: ${e.message}`);
      }
    }
  }),
);
const useful = results
  .filter((r) => (r.planner_tips || r.screen_tips) && r.url_prefixes.length)
  .map((r) => ({
    ...r,
    url_prefixes: r.url_prefixes.map((p) =>
      p
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/\/+$/, "")
        .toLowerCase(),
    ),
  }))
  .sort((a, b) => a.key.localeCompare(b.key));
fs.writeFileSync("src/sites.json", JSON.stringify(useful, null, 1));
const usd = (tokensIn * 0.1 + tokensOut * 0.5) / 1e6;
console.log(
  `\n${useful.length} of ${sites.length} sites kept -> src/sites.json; ${tokensIn} in / ${tokensOut} out tokens, ~$${usd.toFixed(3)}`,
);
