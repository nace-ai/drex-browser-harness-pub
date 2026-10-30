// How a failed model request is told apart: llm.ts and the loop agent (src/loop/agent.ts) both judge from these patterns
// whether it is sent again, so that the two classify an error the same way. The file has no imports, so that the loop's
// bundles can use it without bringing in llm.ts and the AI SDK.

/** The request failed before any answer: a fetch that couldn't connect (the network dropped, or the host's interfaces
 * changed under Chrome). Said by the error's message. */
export const UNSENT_MESSAGE =
  /failed to fetch|fetch failed|cannot connect to api|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_(RESET|CLOSED|REFUSED)/i;
/** A timeout or an abort after the request went out is billed for an unknown amount, so it is never sent again. Said by
 * the error's name, or by its message. */
export const TIMEOUT_NAME = /timeout|abort/i;
export const TIMEOUT_MESSAGE = /timed? ?out|abort/i;
/** A failure with no HTTP answer that a later try may pass: a dropped connection. Its class or name says so, and does not
 * say that it was a timeout or an abort. */
export const CONNECTION_KIND = /APIConnectionError|FetchError|TypeError/;
export const TIMEOUT_KIND = /Timeout|Abort/;
