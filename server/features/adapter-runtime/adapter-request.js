import { randomBytes } from "node:crypto";
import { classifyTransportError } from "../protocol-adapter/translate.js";
import { transportError } from "../providers/endpoint-stream.js";
import { writeRendered } from "./adapter-http.js";

const SSE = { "content-type": "text/event-stream", "cache-control": "no-cache" };
/** Upstream error bodies are read up to this size (enough for any error envelope). */
const MAX_ERROR_TEXT = 1024 * 1024;
/** Non-streaming upstream bodies are read up to this size. */
const MAX_JSON_TEXT = 32 * 1024 * 1024;
// Client frames after which nothing else is written (no keep-alive after the end).
const TERMINAL_FRAME =
  /^event: (?:message_stop|error|response\.(?:completed|incomplete|failed))\r?\n/;

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
      if (stopped || res.destroyed) return;
      res.write(current().keepalive());
      arm();
    }, ctx.timing.keepaliveMs);
  };
  ctx.keepalives?.add(stop);
  return { arm, stop };
}

/** Resolves on `drain` or `close`, whichever comes first, removing both listeners. */
function drained(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
  });
}

/**
 * One upstream attempt: the translator's protocol headers plus authentication and
 * `accept`; no client header is forwarded. Transport failures are classified and
 * counted unless `signal` was aborted (client disconnect).
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

/**
 * Serves one inference request with its own request id and exchange. Responses streams
 * start at once (errors are in-stream for Codex) and get keep-alives from the start;
 * Messages responses start only after the upstream answered 2xx, so upstream rejections
 * stay HTTP error bodies, and pings follow the first frame (spec Amendment 16).
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
  res.on("close", () => {
    if (res.writableFinished) return;
    ctx.counters.increment("clientDisconnects");
    controller.abort(transportError("network", "client disconnected"));
  });
  const pings = keepalives(ctx, res, () => exchange);
  if (started) {
    res.writeHead(200, SSE);
    pings.arm();
  }
  const render = (rendered) => writeRendered(res, rendered);
  let response = null;
  let consumed = false;
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
    if (!started) res.writeHead(200, SSE);
    let stopped = false;
    for await (const frame of exchange.translateStream(response.chunks)) {
      if (res.destroyed) {
        stopped = true;
        break;
      }
      const writable = res.write(frame);
      if (TERMINAL_FRAME.test(frame)) pings.stop();
      else pings.arm();
      if (!writable && !res.destroyed) await drained(res);
    }
    consumed = !stopped;
    if (!res.destroyed) res.end();
  } finally {
    pings.stop();
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
