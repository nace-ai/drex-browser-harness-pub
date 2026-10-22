import assert from "node:assert/strict";
import { test } from "node:test";
import * as L from "../src/logic.ts";

const MAP = [
  "My Account -> /customer/account/",
  "Video Games -> /video-games.html",
  "Video Games › Nintendo Switch › Accessories -> /video-games/nintendo-switch/accessories.html (in a closed menu)",
  "Beauty & Personal Care › Oral Care › Dental Floss & Picks -> /beauty-personal-care/oral-care/dental-floss-picks.html (in a closed menu)",
  "REPORTS › Marketing › Search Terms -> /admin/search/term/report/ (in a closed menu)",
];

test("siteMapFor: the shown links, then the hidden ones whose menu path shares a word with the task", () => {
  // the storefront's 250 category links would add ~5,000 tokens to every plan call
  assert.deepEqual(L.siteMapFor(MAP, "Find a Nintendo Switch card holder with 15 slots"), [MAP[0], MAP[1], MAP[2]]);
  // a word's first five letters: "terms" finds "Terms"; "search" finds "Search"
  assert.deepEqual(L.siteMapFor(MAP, "Show the top search terms in the store").slice(2), [MAP[4]]);
  assert.deepEqual(L.siteMapFor(MAP, "Log out").length, 2); // shown links only
  const many = Array.from({ length: 120 }, (_, i) => `Link ${i} -> /l${i}`);
  assert.equal(L.siteMapFor(many, "anything").length, 50);
});
