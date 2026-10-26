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

// n links the page shows (none in a closed menu): filler that only makes a map long enough
const shownLinks = (n) => Array.from({ length: n }, (_, i) => `Link ${i} -> /l${i}`);

test("siteMapWanted: a closed-menu entry that shares a stem with the task wants the map; a map of shown links alone doesn't", () => {
  const magento = [
    "Home -> /",
    "Sign In -> /customer/account/login",
    "Office Products › Office Furniture › Cabinets, Racks & Shelves -> /office-products/cabinets-racks-shelves.html (in a closed menu)",
    "Beauty & Personal Care › Skin Care -> /beauty-personal-care/skin-care.html (in a closed menu)",
    ...shownLinks(30), // a storefront's map holds 250 links
  ];
  assert.equal(L.siteMapWanted(magento, "Open the Cabinets, Racks & Shelves category page"), true);
  assert.equal(L.siteMapWanted(magento, "Add the cheapest skin care product to my wishlist"), true);
  assert.equal(L.siteMapWanted(magento, "What is the total of my last order?"), false);
  const reddit = Array.from({ length: 19 }, (_, i) => `Forum ${i} -> /f/forum${i}`);
  assert.equal(L.siteMapWanted(reddit, "Upvote the newest post in the nyc forum"), false);
  // a shown link that matches is not enough: Drex sees it on the page already
  assert.equal(L.siteMapWanted(["Reports -> /admin/reports"], "Open the sales report"), false);
  // not in a map long enough to give, either
  assert.equal(L.siteMapWanted([...shownLinks(40), "Reports -> /admin/reports"], "Open the sales report"), false);
});

test("siteMapWanted: a map under 30 links is not given, even when a closed-menu entry matches the task", () => {
  const entry = "Forums -> /forums (in a closed menu)";
  const task = "Upvote the newest post in the nyc forum";
  // reddit's whole map is 19 links: a nav bar, not a menu system worth giving the planner
  assert.equal(L.siteMapWanted([...shownLinks(18), entry], task), false);
  // the same entry in a storefront-sized map
  assert.equal(L.siteMapWanted([...shownLinks(39), entry], task), true);
  // 30 links is enough, 29 is not
  assert.equal(L.siteMapWanted([...shownLinks(29), entry], task), true);
  assert.equal(L.siteMapWanted([...shownLinks(28), entry], task), false);
});

test("resolveAddress: a path copied from the site map opens on the page's own site; an absolute URL is unchanged; webOnly's refusals stay", () => {
  const here = "http://shop.test/admin/dashboard/";
  // the planner copies the map's paths as they are (the map prints paths, not absolute URLs)
  assert.equal(L.resolveAddress("/admin/sales/order/", here), "http://shop.test/admin/sales/order/");
  assert.equal(
    L.resolveAddress("/catalog/category/view/?id=5&p=2", here),
    "http://shop.test/catalog/category/view/?id=5&p=2",
  );
  // the exact inverse of how the map prints a link (its pathname + search), on the page's own origin, port included
  assert.equal(
    L.resolveAddress("/admin/sales/order/view/?id=7", "http://10.0.0.5:7780/admin/dashboard/"),
    "http://10.0.0.5:7780/admin/sales/order/view/?id=7",
  );
  assert.equal(L.resolveAddress("?page=2", "http://shop.test/list?page=1"), "http://shop.test/list?page=2");
  assert.equal(L.resolveAddress("orders.html", here), "http://shop.test/admin/dashboard/orders.html");
  // a scheme-relative address names another site: left as it is, for webOnly to refuse (it was malformed before)
  assert.equal(L.resolveAddress("//cdn.test/x", "https://shop.test/"), "//cdn.test/x");
  // an absolute URL is unchanged, written as it was
  assert.equal(L.resolveAddress("https://other.test/x", here), "https://other.test/x");
  assert.equal(L.resolveAddress("http://shop.test", here), "http://shop.test");
  // what webOnly refuses is left to it: a non-web scheme, prose, nothing at all
  for (const url of [
    "javascript:alert(1)",
    "file:///etc/hosts",
    "chrome://settings",
    "data:text/html,x",
    "not a url",
    "",
  ])
    assert.equal(L.resolveAddress(url, here), url);
  // and a path with no web page to resolve it on stays a path (webOnly then calls it malformed)
  for (const base of [undefined, null, "", "about:blank", "chrome://newtab/", "file:///tmp/a.html"])
    assert.equal(L.resolveAddress("/admin/sales/order/", base), "/admin/sales/order/");
});

test("resolveAddress: a relative address never leaves the page's site, however the parser reads its slashes", () => {
  // the map prints a same-origin link as pathname + search, so a double-slash link on the page prints as "//evil.test/x?y=1"
  const forms = [
    "//evil.test/x?y=1",
    "//cdn.test/x",
    "/\\evil.test/x", // /\evil.test/x
    "\\\\evil.test\\x", // \\evil.test\x
    "\\/evil.test/x", // \/evil.test/x
    " //evil.test/x ",
    "/\t/evil.test/x", // the parser drops a tab or newline: "/", tab, "/" is "//"
    "/\n/evil.test/x",
  ];
  for (const base of ["https://shop.test/admin/dashboard/", "http://shop.test:7780/", "http://10.0.0.5/a/b?c#d"])
    for (const url of forms) assert.equal(L.resolveAddress(url, base), url, `${url} on ${base}`);
  // whatever it resolves to is on the page's origin
  for (const url of [
    "/a",
    "/a/../b/./c?d=e#f",
    "../up",
    "./here",
    "?q=1",
    "#top",
    "x.html",
    "/a//b",
    "/%2F%2Fevil.test",
  ])
    assert.equal(new URL(L.resolveAddress(url, "https://shop.test:8443/m/n/o")).origin, "https://shop.test:8443", url);
});

test("isRelativeAddress: an address with no scheme, not prose", () => {
  for (const url of ["/admin/sales/order/", "?page=2", "orders.html", "//cdn.test/x", " /admin/x "])
    assert.equal(L.isRelativeAddress(url), true, url);
  for (const url of ["https://shop.test/x", "javascript:alert(1)", "file:///etc/hosts", "not a url", "", "  "])
    assert.equal(L.isRelativeAddress(url), false, url);
});

test("an open_url that is not text (the LLM's JSON) is no address: nothing throws, and it comes back as it was", () => {
  for (const value of [5, null, undefined, {}, ["/admin/x"], true]) {
    assert.equal(L.isRelativeAddress(value), false);
    assert.equal(L.resolveAddress(value, "https://shop.test/"), value);
  }
});

test("firstUrl: the first http(s) address written in a text, without the punctuation after it", () => {
  assert.equal(L.firstUrl("Go to http://shop.test/admin, then open the orders."), "http://shop.test/admin");
  assert.equal(L.firstUrl("Compare https://a.test/x and https://b.test/y"), "https://a.test/x");
  assert.equal(L.firstUrl("Sort the list (see https://a.test/list?sort=asc)."), "https://a.test/list?sort=asc");
  assert.equal(L.firstUrl("Open the sales report"), "");
  assert.equal(L.firstUrl(undefined), "");
});
