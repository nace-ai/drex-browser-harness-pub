import http from "node:http";
import net from "node:net";
import { pipeline } from "node:stream";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

// range() calls these unicast: deprecated site-local and IPv4-compatible IPv6 are never a public site
const DEPRECATED = [ipaddr.parseCIDR("fec0::/10"), ipaddr.parseCIDR("::/96")];
const isPublic = (address) => {
  const ip = ipaddr.process(address);
  return ip.range() === "unicast" && !(ip.kind() === "ipv6" && DEPRECATED.some((cidr) => ip.match(cidr)));
};

/** A proxy used by Chromium only. Node's model/callback transport does not use
 * it. Validate every CONNECT and HTTP request, including redirect destinations,
 * and pin DNS results so rebinding cannot turn a public hostname into localhost. */
export async function browserProxy(origins, { allowLocal = false } = {}) {
  const allowed = new Set(origins);
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    return socket;
  };
  async function address(url) {
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !allowed.has(url.origin))
      throw new Error("Origin denied");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await lookup(host, { all: true });
    if (!addresses.length || (!allowLocal && !addresses.every((a) => isPublic(a.address))))
      throw new Error("Non-public address denied");
    // connect to the checked addresses only (no second lookup to rebind), trying each family as the network allows
    return {
      host,
      autoSelectFamily: true,
      lookup: (name, options, callback) =>
        options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
    };
  }
  const server = http.createServer(async (req, res) => {
    let url, target;
    try {
      url = new URL(req.url);
      if (url.protocol !== "http:") throw new Error("Expected HTTP"); // https comes as CONNECT
      target = await address(url);
    } catch {
      res.writeHead(403);
      res.end("Origin denied");
      return;
    }
    const headers = { ...req.headers, host: url.host };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const outgoing = http.request(
      {
        ...target,
        port: url.port || 80,
        method: req.method,
        path: url.pathname + url.search,
        headers,
        timeout: 30000,
      },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        // an upstream cut mid-body must reach Chromium as a broken response, not a stalled one
        pipeline(response, res, () => {});
      },
    );
    outgoing.on("socket", track);
    outgoing.on("timeout", () => outgoing.destroy());
    outgoing.on("error", () => {
      // an upstream reset fires here before the response breaks: once headers went out, ending cleanly would stall
      if (res.headersSent) return res.destroy();
      res.writeHead(502);
      res.end();
    });
    req.on("aborted", () => outgoing.destroy());
    req.pipe(outgoing);
  });
  server.on("connection", track);
  server.on("connect", async (req, socket, head) => {
    // Node hands a CONNECT socket over without an error listener: a client reset during the lookup must not crash the worker
    socket.on("error", () => socket.destroy());
    let url, target;
    try {
      url = new URL(`https://${req.url}`);
      target = await address(url);
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    if (socket.destroyed) return;
    const upstream = track(net.connect({ ...target, port: Number(url.port || 443) }));
    upstream.setTimeout(60000, () => upstream.destroy());
    upstream.on("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
