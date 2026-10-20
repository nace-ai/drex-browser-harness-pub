// Site tips condensed from browser-harness's per-site guides (scripts/distill-sites.mjs; MIT, Browser Use, see
// third_party/). Pure functions over the bundled list, so node:test covers them.

import type { Site } from "./types.ts";

const MAX_TASK_SITES = 4;

/** "https://www.mail.google.com/mail/u/0#inbox" -> "mail.google.com/mail/u/0" */
function bare(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host.replace(/^www\./, "")}${u.pathname}`.replace(/\/+$/, "").toLowerCase();
  } catch {
    return "";
  }
}

function matches(prefix: string, b: string): boolean {
  return (
    b === prefix ||
    b.startsWith(`${prefix}/`) ||
    b.startsWith(`${prefix}?`) ||
    b.endsWith(`.${prefix}`) ||
    b.includes(`.${prefix}/`)
  );
}

/** The site whose URL prefix matches this page best (longest prefix), or null. */
export function siteFor(sites: Site[], url: string): Site | null {
  const b = bare(url);
  if (!b) return null;
  let best: Site | null = null;
  let bestLen = 0;
  for (const s of sites) {
    for (const p of s.url_prefixes) {
      if (p.length > bestLen && matches(p, b)) {
        best = s;
        bestLen = p.length;
      }
    }
  }
  return best;
}

/** Sites the task names (by name or host) or that are open in a tab, at most a few. */
export function sitesForTask(sites: Site[], task: string, urls: string[] = []): Site[] {
  const t = ` ${task.toLowerCase()} `;
  const picked: Site[] = [];
  const add = (s: Site | null): void => {
    if (s && !picked.includes(s) && picked.length < MAX_TASK_SITES) picked.push(s);
  };
  for (const s of sites) {
    const words = [...s.names, s.name.toLowerCase(), ...s.url_prefixes.map((p) => p.split("/")[0])];
    if (words.some((w) => w && new RegExp(`[^a-z0-9]${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^a-z0-9]`).test(t)))
      add(s);
  }
  for (const u of urls) add(siteFor(sites, u));
  return picked;
}
