import { capabilityForError } from "../protocol-adapter/translate.js";
import { classifyUpstreamError } from "../protocol-adapter/errors.js";
import { newRequestId, ok, send, MAX_ERROR_TEXT } from "./adapter-request.js";

/**
 * The 400/422 → capability retry of one session (spec "Capabilities"). The handler calls
 * it at most once per request, and only while nothing was written to the client. The
 * retry builds a fresh exchange with a new request id; the changed capability stays for
 * the session only if the retried request succeeds, otherwise the previous value returns.
 *
 * Concurrency: `capabilities` is the snapshot the failed request was built with. A
 * request built with the fallback value already is not retried (the mapping misfired);
 * one whose capability another request switched meanwhile is rebuilt with the current
 * value without owning the change. Any successful retry confirms its value (counted
 * `kept` once per confirmation); an owner whose own retry fails afterwards (transient
 * 429/5xx, transport) does not revert a confirmed value. A revert restores the value this
 * request replaced, even if another request changed it in between (accepted: the next
 * rejection switches it again).
 */
export function createRetry(ctx) {
  const tally = (change, outcome) =>
    ctx.counters.fallback(`${change.name}=${change.value}`, outcome);
  // Per capability: the value a successful retry proved (survives later failed retries).
  const confirmed = {};
  return async ({
    body,
    headers,
    capabilities = ctx.capabilities,
    streaming,
    status,
    text,
    responseHeaders,
    signal,
    adopt = () => {},
  }) => {
    const error = classifyUpstreamError({
      protocol: ctx.upstream,
      status,
      body: text,
      headers: responseHeaders,
      secrets: ctx.secrets,
    });
    const change = capabilityForError(ctx.upstream, error);
    if (!change || capabilities[change.name] === change.value) return null;
    const owned = ctx.capabilities[change.name] !== change.value;
    const previous = ctx.capabilities[change.name];
    if (owned) ctx.setCapability(change.name, change.value);
    const revert = () => {
      if (!owned || confirmed[change.name] === change.value) return false;
      ctx.setCapability(change.name, previous);
      return true;
    };
    const rebuilt = ctx.translator.buildUpstream(body, headers, {
      requestId: newRequestId(ctx.client),
      now: ctx.now(),
    });
    if (!rebuilt.ok) {
      revert();
      return null;
    }
    // Keep-alives during the retry belong to the exchange the client will see.
    adopt(rebuilt.exchange);
    const attempt = await send(ctx, rebuilt.request, streaming, signal);
    if (attempt.response && ok(attempt.response.status)) {
      if (confirmed[change.name] !== change.value) tally(change, "kept");
      confirmed[change.name] = change.value;
      return { ok: true, response: attempt.response, exchange: rebuilt.exchange };
    }
    // An adapter-side abort (client gone, shutdown) says nothing about the capability.
    if (revert() && !signal?.aborted) tally(change, "reverted");
    if (attempt.failure)
      return { ok: false, exchange: rebuilt.exchange, failure: attempt.failure };
    let retryText = "";
    try {
      retryText = await attempt.response.text(MAX_ERROR_TEXT);
    } catch {
      attempt.response.cancel();
    }
    return {
      ok: false,
      exchange: rebuilt.exchange,
      status: attempt.response.status,
      text: retryText,
      headers: attempt.response.headers,
    };
  };
}
