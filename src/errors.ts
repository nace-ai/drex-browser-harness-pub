// Errors from model calls, described for the run's record.

/** What an SDK error says beneath its wrapper ("Failed to process successful response" wraps the real cause): each
 * error of its cause chain with its status, the response's request id, content type and length, and the start of
 * any response body. No request content and no key. */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let e = error as {
    // anything can be thrown: a cause need not be an Error (no prototype, a message that isn't a string)
    name?: unknown;
    message?: unknown;
    constructor?: { name?: string };
    statusCode?: number;
    status?: number | null;
    cause?: unknown;
    responseHeaders?: Record<string, string>;
    responseBody?: string;
  } | null;
  for (let depth = 0; e && depth < 5; depth++) {
    if (typeof e !== "object") {
      parts.push(String(e).slice(0, 200));
      break;
    }
    const h = e.responseHeaders ?? {};
    const name = typeof e.name === "string" && e.name ? e.name : (e.constructor?.name ?? "Error");
    const fields = [
      `${name}: ${typeof e.message === "string" ? e.message.slice(0, 300) : ""}`,
      (e.statusCode ?? e.status) ? `status ${String(e.statusCode ?? e.status)}` : "",
      h["request-id"] ? `request-id ${h["request-id"]}` : "",
      h["content-type"] ? `content-type ${h["content-type"]}` : "",
      h["content-length"] ? `content-length ${h["content-length"]}` : "",
      typeof e.responseBody === "string" ? `body ${JSON.stringify(e.responseBody.slice(0, 300))}` : "",
    ].filter(Boolean);
    parts.push(fields.join(", "));
    e = e.cause as typeof e;
  }
  return parts.join(" <- ");
}
