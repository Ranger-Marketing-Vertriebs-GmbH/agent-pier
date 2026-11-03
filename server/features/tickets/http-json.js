import { serverMessages } from "../../lib/i18n/de.js";

export class TicketSourceError extends Error {
  constructor(code) {
    super(serverMessages.tickets.source[code]);
    this.name = "TicketSourceError";
    this.code = code;
    this.status = code === "notConnected" ? 409 : 502;
  }
}

function codeForStatus(status, headers) {
  if (status === 401) return "unauthorized";
  if (status === 403)
    return headers.get("x-ratelimit-remaining") === "0" ? "rateLimited" : "forbidden";
  if (status === 404) return "notFound";
  if (status === 429) return "rateLimited";
  if (status >= 500) return "unavailable";
  return "invalidResponse";
}

async function readLimited(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new TicketSourceError("invalidResponse");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function requestJson({
  fetchImpl = fetch,
  url,
  method = "GET",
  headers = {},
  body,
  signal,
  timeoutMs = 15000,
  maxBytes = 4 * 1024 * 1024,
}) {
  // A referenced timer keeps the request alive until it settles; AbortSignal.timeout is unref'd.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error("timeout")), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  const sent = { ...headers };
  if (body !== undefined) sent["Content-Type"] = "application/json";
  try {
    const response = await fetchImpl(url, {
      method,
      headers: sent,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combined,
    });
    if (response.status < 200 || response.status > 299) {
      await response.body?.cancel?.().catch(() => {});
      throw new TicketSourceError(codeForStatus(response.status, response.headers));
    }
    const raw = await readLimited(response, maxBytes);
    let data = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        throw new TicketSourceError("invalidResponse");
      }
    }
    return { status: response.status, data, headers: response.headers };
  } catch (error) {
    if (error instanceof TicketSourceError) throw error;
    throw new TicketSourceError("unreachable");
  } finally {
    clearTimeout(timer);
  }
}
