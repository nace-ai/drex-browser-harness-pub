// The worker's browser proxy (runner/src/worker-network.mjs) on its own, without Chromium: CONNECT and plain HTTP are
// held to the declared origins, and names that resolve to private addresses are refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { browserProxy } from "../runner/src/worker-network.mjs";

/** Sends a raw request to the proxy and resolves with the first line of its answer ("" if it closed). */
function raw(proxy, text) {
  const { port } = new URL(proxy.url);
  return new Promise((resolve) => {
    const socket = net.connect(Number(port), "127.0.0.1", () => socket.write(text));
    let data = "";
    socket.on("data", (d) => {
      data += d;
      if (data.includes("\r\n")) {
        socket.destroy();
        resolve(data.split("\r\n")[0]);
      }
    });
    socket.on("close", () => resolve(data.split("\r\n")[0]));
    socket.on("error", () => resolve(""));
  });
}

test("CONNECT reaches a declared origin and is refused for any other", async () => {
  const site = net.createServer((s) => s.end("hello"));
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const host = `127.0.0.1:${site.address().port}`;
  const proxy = await browserProxy([`https://${host}`], { allowLocal: true });
  try {
    assert.match(await raw(proxy, `CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n\r\n`), /^HTTP\/1.1 200/);
    assert.match(await raw(proxy, `CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n`), /^HTTP\/1.1 403/);
  } finally {
    await proxy.close();
    site.close();
  }
});

test("names resolving to loopback are refused unless local fixtures are allowed", async () => {
  const site = http.createServer((req, res) => res.end("ok"));
  site.listen(0, "127.0.0.1"); // localhost may resolve to ::1 first: the proxy must fall back to 127.0.0.1
  await once(site, "listening");
  const origin = `http://localhost:${site.address().port}`;
  const request = `GET ${origin}/ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`;
  const strict = await browserProxy([origin, "https://localhost"]);
  const local = await browserProxy([origin], { allowLocal: true });
  try {
    assert.match(await raw(strict, request), /^HTTP\/1.1 403/);
    assert.match(await raw(strict, "CONNECT localhost:443 HTTP/1.1\r\nHost: localhost:443\r\n\r\n"), /^HTTP\/1.1 403/);
    assert.match(await raw(local, request), /^HTTP\/1.1 200/);
  } finally {
    await strict.close();
    await local.close();
    site.close();
  }
});

test("private, metadata and IPv6-embedded loopback addresses are refused even when declared", async () => {
  const hosts = [
    "169.254.169.254",
    "10.0.0.1",
    "100.64.0.1",
    "0.0.0.0",
    "[::ffff:127.0.0.1]",
    "[::7f00:1]",
    "[fec0::1]",
    "[64:ff9b::7f00:1]",
  ];
  const proxy = await browserProxy(hosts.flatMap((h) => [`https://${h}`, `http://${h}`]));
  try {
    for (const h of hosts) {
      assert.match(await raw(proxy, `CONNECT ${h}:443 HTTP/1.1\r\nHost: ${h}:443\r\n\r\n`), /^HTTP\/1.1 403/, h);
      assert.match(await raw(proxy, `GET http://${h}/ HTTP/1.1\r\nHost: ${h}\r\n\r\n`), /^HTTP\/1.1 403/, h);
    }
  } finally {
    await proxy.close();
  }
});

test("plain HTTP to an undeclared origin is refused by the proxy itself", async () => {
  const site = http.createServer((req, res) => res.end("ok"));
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const proxy = await browserProxy(["http://127.0.0.1:1"], { allowLocal: true });
  try {
    const host = `127.0.0.1:${site.address().port}`;
    assert.match(await raw(proxy, `GET http://${host}/ HTTP/1.1\r\nHost: ${host}\r\n\r\n`), /^HTTP\/1.1 403/);
  } finally {
    await proxy.close();
    site.close();
  }
});

test("a client that resets a CONNECT while it is being checked does not crash the worker", async () => {
  const proxy = await browserProxy(["https://example.invalid"]);
  try {
    const { port } = new URL(proxy.url);
    const socket = net.connect(Number(port), "127.0.0.1", () => {
      socket.write("CONNECT example.invalid:443 HTTP/1.1\r\nHost: example.invalid:443\r\n\r\n");
      setTimeout(() => socket.resetAndDestroy(), 5);
    });
    await once(socket, "close");
    await new Promise((r) => setTimeout(r, 200)); // the lookup ends and the 403 is written to the reset socket
  } finally {
    await proxy.close();
  }
});

for (const [cut, how] of [
  ["closed", (res) => res.destroy()],
  ["reset", (res) => res.socket.resetAndDestroy()],
]) {
  test(`an upstream ${cut} mid-body breaks the browser's response instead of stalling it`, async () => {
    const site = http.createServer((req, res) => {
      res.writeHead(200, { "content-length": "100" });
      res.write("partial");
      setTimeout(() => how(res), 50);
    });
    site.listen(0, "127.0.0.1");
    await once(site, "listening");
    const origin = `http://127.0.0.1:${site.address().port}`;
    const proxy = await browserProxy([origin], { allowLocal: true });
    const { port } = new URL(proxy.url);
    let socket;
    try {
      let data = "";
      const closed = await new Promise((resolve) => {
        socket = net.connect(Number(port), "127.0.0.1", () =>
          socket.write(`GET ${origin}/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`),
        );
        socket.on("data", (d) => (data += d));
        socket.on("close", () => resolve(true));
        socket.on("error", () => {});
        setTimeout(() => resolve(false), 5000).unref();
      });
      assert.equal(closed, true);
      assert.match(data, /^HTTP\/1\.1 200[\s\S]*partial$/);
    } finally {
      socket?.destroy();
      await proxy.close();
      site.closeAllConnections();
      site.close();
    }
  });
}
