import { randomBytes } from "node:crypto";
import { classifyTransportError } from "../protocol-adapter/translate.js";
import { transportError } from "../providers/endpoint-stream.js";
import { writeRendered } from "./adapter-http.js";

const SSE = { "content-type": "text/event-stream", "cache-control": "no-cache" };
/** Upstream error bodies are read up to this size (enough for any error envelope). */
const MAX_ERROR_TEXT = 1024 * 1024;
/** Non-streaming upstream bodies are read up to this size. */
const MAX_JSON_TEXT = 32 * 1024 * 1024;

/**
 * Why a request was aborted by the adapter side: the counter it lands in and the
 * transport error the upstream request is destroyed with. `firstFrame` is an upstream
 * timeout (counted by the translator as `stream.timeout`); the others are not upstream
 * failures and stay out of the translator's stream counters.
 */
const ABORTS = Object.freeze({
  client: { scalar: "clientDisconnects", kind: "network", text: "client disconnected" },
  shutdown: { scalar: "shutdownAborts", kind: "network", text: "adapter shutting down" },
  stalled: { error: "client.stalled", kind: "network", text: "client stopped reading" },
  firstFrame: { kind: "timeout", text: "upstream sent no client frame" },
});

export const ok = (status) => status >= 200 && status < 300;

const newRequestId = (client) =>
  `${client === "messages" ? "msg" : "resp"}_${randomBytes(16).toString("hex")}`;

/** Keep-alive timer: one frame `ms` after the last write; `arm` restarts it. */
function keepalives(ctx, res, current) {
  let timer = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    ctx.keepalives?.delete(stop);
  };
  const arm = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (stopped || res.destroyed || current().terminated) return;
      res.write(current().keepalive());
      arm();
    }, ctx.timing.keepaliveMs);
  };
  ctx.keepalives?.add(stop);
  return { arm, stop };
}

/**
 * Resolves true on `drain`, false on `close` or when the client has not read for `ms`;
 * removes its listeners and timer either way.
 */
function drained(res, ms) {
  return new Promise((resolve) => {
    let timer = null;
    const finish = (value) => {
      clearTimeout(timer);
      res.off("drain", onDrain);
      res.off("close", onClose);
      resolve(value);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    res.on("drain", onDrain);
    res.on("close", onClose);
    timer = setTimeout(() => finish(false), ms);
  });
}

/**
 * One upstream attempt: the translator's protocol headers plus authentication and
 * `accept`; no client header is forwarded. Transport failures are classified and
 * counted unless `signal` was aborted by the adapter side (disconnect, shutdown).
 */
export async function send(ctx, request, streaming, signal) {
  try {
    const response = await ctx.upstreamClient.request({
      path: request.path,
      body: request.body,
      signal,
      idleTimeoutMs: ctx.timing.idleTimeoutMs,
      headers: {
        ...request.headers,
        ...ctx.upstreamAuth,
        accept: streaming ? "text/event-stream" : "application/json",
      },
    });
    ctx.counters.status(response.status);
    return { response };
  } catch (error) {
    const failure = classifyTransportError(error, ctx.secrets);
    if (!signal?.aborted) ctx.counters.count("errors", `transport.${failure.kind}`);
    return { failure };
  }
}

/** Per-request abort: counts the cause once and aborts the upstream with it. */
function createAbort(ctx, controller) {
  let quiet = false;
  const abort = (reason) => {
    if (controller.signal.aborted) return;
    const cause = ABORTS[reason];
    if (cause.scalar) ctx.counters.increment(cause.scalar);
    if (cause.error) ctx.counters.count("errors", cause.error);
    quiet = reason !== "firstFrame";
    controller.abort(transportError(cause.kind, cause.text));
  };
  return { abort, quiet: () => quiet };
}

/**
 * Serves one inference request with its own request id and exchange. Responses streams
 * start at once (errors are in-stream for Codex) and get keep-alives from the start;
 * Messages responses start only after the upstream answered 2xx, so upstream rejections
 * stay HTTP error bodies, and pings follow the first frame; until that frame the wait is
 * bounded by the idle timeout (spec Amendment 16).
 */
export async function handleInference(ctx, req, res, rawBody) {
  const requestId = newRequestId(ctx.client);
  let body = null;
  try {
    body = JSON.parse(rawBody);
  } catch {
    /* The translator renders the 400 for a null body. */
  }
  const built = ctx.translator.buildUpstream(body, req.headers, {
    requestId,
    now: ctx.now(),
  });
  if (!built.ok) return writeRendered(res, built.error);
  const streaming = body?.stream === true;
  const started = streaming && ctx.client === "responses";
  let exchange = built.exchange;
  const controller = new AbortController();
  const { abort, quiet } = createAbort(ctx, controller);
  const onClose = () => {
    if (!res.writableFinished) abort(ctx.closing ? "shutdown" : "client");
  };
  res.on("close", onClose);
  ctx.requests?.add(abort);
  // The client may have gone away before the listener existed.
  if (res.destroyed || req.socket?.destroyed) onClose();
  const pings = keepalives(ctx, res, () => exchange);
  if (started) {
    res.writeHead(200, SSE);
    pings.arm();
  }
  const render = (rendered) => writeRendered(res, rendered);
  let response = null;
  let consumed = false;
  let firstFrame = null;
  try {
    const first = await send(ctx, built.request, streaming, controller.signal);
    if (first.failure)
      return render(exchange.fail(first.failure, { streaming, started }));
    response = first.response;
    if (!ok(response.status)) {
      let text = "";
      try {
        text = await response.text(MAX_ERROR_TEXT);
        consumed = true;
      } catch {
        /* An unreadable error body is classified by status alone. */
      }
      const outcome =
        (await ctx.retry?.({
          body,
          headers: req.headers,
          requestId,
          streaming,
          status: response.status,
          text,
          responseHeaders: response.headers,
          signal: controller.signal,
        })) ?? null;
      if (outcome?.exchange) exchange = outcome.exchange;
      if (outcome?.ok) {
        response = outcome.response;
        consumed = false;
      } else {
        const last = outcome ?? {
          status: response.status,
          text,
          headers: response.headers,
        };
        return render(
          last.failure
            ? exchange.fail(last.failure, { streaming, started })
            : exchange.translateError(
                { status: last.status, body: last.text, headers: last.headers },
                { streaming, started },
              ),
        );
      }
    }
    if (!streaming) {
      consumed = true; // respondJson reads (or releases) the body itself
      return await respondJson(ctx, res, exchange, response, controller.signal);
    }
    if (!started) {
      res.writeHead(200, SSE);
      // Upstream bytes that yield no client frame (SSE comments, a lone role chunk) keep
      // the upstream idle timer alive; this bounds Claude Code's wait for message_start.
      firstFrame = setTimeout(() => abort("firstFrame"), ctx.timing.idleTimeoutMs);
    }
    let stopped = false;
    for await (const frame of exchange.translateStream(response.chunks, {
      silent: quiet,
    })) {
      clearTimeout(firstFrame);
      if (res.destroyed) {
        stopped = true;
        break;
      }
      const writable = res.write(frame);
      if (exchange.terminated) pings.stop();
      else pings.arm();
      if (
        !writable &&
        !res.destroyed &&
        !(await drained(res, ctx.timing.idleTimeoutMs))
      ) {
        // The client stopped reading (or left): release the upstream and the socket.
        abort("stalled");
        res.destroy();
        stopped = true;
        break;
      }
    }
    consumed = !stopped;
    if (!res.destroyed) res.end();
  } finally {
    clearTimeout(firstFrame);
    pings.stop();
    ctx.requests?.delete(abort);
    // A response the client no longer reads releases its upstream socket.
    if (response && !consumed) response.cancel();
  }
}

async function respondJson(ctx, res, exchange, response, signal) {
  let text;
  try {
    text = await response.text(MAX_JSON_TEXT);
  } catch (error) {
    const failure = classifyTransportError(error, ctx.secrets);
    if (!signal.aborted) ctx.counters.count("errors", `transport.${failure.kind}`);
    return writeRendered(res, exchange.fail(failure, { streaming: false }));
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* translateResponse renders an untranslatable body as a server error. */
  }
  try {
    const clientBody = await exchange.translateResponse(json);
    if (res.destroyed) return;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(clientBody));
  } catch (error) {
    if (!error?.clientError) throw error;
    writeRendered(res, error.clientError);
  }
}
