// Translator: composes one client module and one upstream module into a per-session
// protocol adapter. Pure: no I/O, timers, clock or randomness; time and ids come in.

/**
 * createTranslator({ client, upstream, model, capabilities, thinkTagExtraction,
 *                    sessionKey, secrets })
 *
 * - `client`: "messages" (Claude Code) | "responses" (Codex).
 * - `upstream`: "messages" | "responses" | "chat"; must differ from `client` (native
 *   routes never use the adapter), otherwise a TypeError is thrown.
 * - `model`: the connection model record `{ modelId, contextTokens, outputTokens, images }`.
 *   `modelId` is the upstream model id; `images: false` rejects image input.
 * - `capabilities`: the connection's `adapterCapabilities` for the upstream protocol,
 *   merged over `CAPABILITY_DEFAULTS[upstream]` (capabilities.js documents every key);
 *   unknown names are ignored, invalid values throw a TypeError.
 * - `sessionKey`: stable per-session string (prompt cache key fallback).
 * - `secrets`: strings redacted from every message that reaches the client (null → none).
 *
 * One tool-name map and one call-id map live per translator (= per session); both use the
 * upstream's patterns, and the IR's tools are registered in IR order on every request so
 * the mapping is stable for the whole session.
 *
 * Methods of the translator: `buildUpstream`, `setCapability` and `diagnostics`. Everything that
 * translates a response lives on the per-request `exchange`, so concurrent requests in one
 * session (Claude Code main agent, subagents and small-model calls; Codex turns) never
 * share a client model, id, request size, include flags, display or custom tools.
 *
 * - `buildUpstream(body, headers, { requestId, now? })` →
 *   `{ ok: true, request: { path, body, headers }, dropped, exchange }` or
 *   `{ ok: false, error: { status, headers, body }, exchange }`.
 *   - `requestId` (required, non-empty string, else TypeError): id echoed to the client
 *     as Messages `message.id` or Responses `response.id`. The caller generates a unique
 *     (random) id: Claude Code merges messages by `message.id`, so ids must not repeat
 *     across translator instances.
 *   - `now` (optional): epoch milliseconds; Codex `created_at` and `retry-after` dates.
 *   - `request.headers` contains only protocol headers (`content-type`, Messages
 *     `anthropic-version`); the caller adds authentication. Client headers are never
 *     forwarded.
 *   - `error` is already rendered in the client's error format (as `translateError`
 *     renders it); `exchange` is returned on rejections too, e.g. for keep-alives.
 * - `setCapability(name, value)`: changes one capability for subsequent `buildUpstream`
 *   calls only (TypeError for unknown names or invalid values). With the pure
 *   `capabilityForError(upstream, irError)` it implements the 400/422 → capability retry.
 * - `diagnostics()`: `{ dropped, adjustments, errors, estimatedUsage, cacheReadTokens }`:
 *   counters by name, the number of responses whose usage was estimated and the cached
 *   input tokens (per exchange its highest cumulative `cacheRead`). `dropped`: client
 *   features not sent upstream (hints except the consumed `store`/`include`, hosted tools, sampling
 *   values, orphaned parts); `adjustments`: values the adapter changed (thinking/effort
 *   resolutions, cache breakpoints, clamped max tokens); `errors`: `request.invalid`,
 *   `request.rejected`, `request.imageRejected`, `stream.invalid`, `stream.<kind>`,
 *   `response.invalid`.
 *
 * Exchange methods (the exchange counts the client frames it handed out, so every error
 * it renders later continues the client's numbering):
 * - `translateStream(chunks, { silent })`: upstream SSE text chunks (AsyncIterable<string>) → client
 *   SSE text (AsyncIterable<string>); it never throws. Upstream errors, malformed streams
 *   and failures of the chunk iterator itself (the caller's idle timeout aborting the
 *   fetch, socket resets) end in the client's in-stream error (Messages `event: error`,
 *   Responses `response.failed` with the next `sequence_number`, or `response.created` +
 *   `response.failed` when nothing was written yet). Iterator failures are classified by
 *   `classifyTransportError`: an `adapterKind` property on the thrown error wins,
 *   AbortError/TimeoutError and timeout codes are `timeout`, everything else `network`
 *   (counted as `errors["stream.<kind>"]`); malformed streams count as `stream.invalid`.
 *   `silent()` (optional) returning true skips the `stream.<kind>` count, for failures the
 *   caller caused itself (client disconnect, shutdown).
 * - `translateResponse(json)`: non-streaming upstream body → Promise of the client body.
 *   Rejects with `AdapterUpstreamError` carrying `error` (IrError) and `clientError`
 *   (`{ status, headers, body }` rendered for the client) when the body is an error or
 *   cannot be translated (a server error, counted as `response.invalid`).
 * - `translateError({ status, body, headers }, { streaming, started, now })`: upstream
 *   HTTP error → client rendering. `streaming`: the client asked for a stream (defaults
 *   to the request's `stream`); `started`: the client response has already begun
 *   (headers sent), so only an in-stream frame (string) can be written; once
 *   `translateStream` handed out a frame the error is always in-stream and numbered from
 *   the exchange. Messages client: HTTP body unless started. Responses client:
 *   `stream: true` errors are HTTP 200 SSE (`response.created` + `response.failed`,
 *   because Codex reads errors only from the stream), `stream: false` errors are HTTP
 *   bodies.
 * - `fail(irError, { streaming, started })`: adapter-local failure (e.g. the idle timer
 *   fired while the caller stopped reading `translateStream`, or the connection failed:
 *   `fail(classifyTransportError(cause))`), rendered exactly like `translateError`.
 * - Callers must not render an error after the client stream reached a terminal frame
 *   (Messages `message_stop`/`error`, Responses `response.completed|incomplete|failed`,
 *   including an in-stream error frame rendered by `translateError`/`fail`). As a guard,
 *   `translateError` and `fail` then return null instead of a second terminal frame, and
 *   `translateStream` ends without an error frame when its iterator fails after one. Full
 *   renderings before any frame (HTTP bodies, the Codex error stream) are alternatives the
 *   caller picks from and do not end the exchange.
 * - `keepalive()`: Messages `event: ping` or Responses `response.in_progress` frame
 *   (no `sequence_number`; keep-alives do not count as frames).
 * - `terminated` (getter): true once a terminal client frame was handed out; nothing,
 *   not even a keep-alive, may follow it.
 */

import {
  emitMessagesResponse,
  emitMessagesStream,
  messagesPing,
  parseMessagesRequest,
} from "./client-messages.js";
import {
  emitResponsesResponse,
  emitResponsesStream,
  parseResponsesRequest,
  responsesKeepalive,
} from "./client-responses.js";
import {
  AdapterUpstreamError,
  classifyTransportError,
  classifyUpstreamError,
  messagesErrorBody,
  messagesErrorEvent,
  responsesErrorBody,
  responsesErrorStream,
  responsesFailedEvent,
  sanitizeMessage,
} from "./errors.js";
import { createIdMap, createNameMap } from "./names.js";
import { createSseParser } from "./sse.js";
import { buildChatRequest, parseChatResponse, parseChatStream } from "./upstream-chat.js";
import {
  buildMessagesRequest,
  parseMessagesResponse,
  parseMessagesStream,
} from "./upstream-messages.js";
import {
  buildResponsesRequest,
  parseResponsesResponse,
  parseResponsesStream,
} from "./upstream-responses.js";

import { assertCapability, resolveCapabilities } from "./capabilities.js";

export { CAPABILITY_DEFAULTS, capabilityForError } from "./capabilities.js";
export { classifyTransportError } from "./errors.js";

const ENCRYPTED_REASONING = "reasoning.encrypted_content";
const CALL_ID = /^[a-zA-Z0-9_-]+$/;

const UPSTREAMS = Object.freeze({
  messages: {
    build: buildMessagesRequest,
    parseStream: parseMessagesStream,
    parseResponse: parseMessagesResponse,
    names: { pattern: /^[a-zA-Z0-9_-]{1,128}$/, maxLength: 128 },
  },
  responses: {
    build: buildResponsesRequest,
    parseStream: parseResponsesStream,
    parseResponse: parseResponsesResponse,
    names: { pattern: /^[a-zA-Z0-9_-]{1,64}$/, maxLength: 64 },
  },
  chat: {
    build: buildChatRequest,
    parseStream: parseChatStream,
    parseResponse: parseChatResponse,
    names: { pattern: /^[a-zA-Z0-9_-]{1,64}$/, maxLength: 64 },
  },
});

const CLIENTS = Object.freeze({
  messages: {
    parse: parseMessagesRequest,
    emitStream: emitMessagesStream,
    emitResponse: emitMessagesResponse,
  },
  responses: {
    parse: parseResponsesRequest,
    emitStream: emitResponsesStream,
    emitResponse: emitResponsesResponse,
  },
});

const INVALID_STREAM = Object.freeze({
  kind: "server",
  message: "the upstream stream could not be translated",
});
const INVALID_RESPONSE = Object.freeze({
  kind: "server",
  message: "the upstream response could not be translated",
});
const NO_IMAGES = "this model does not accept image input";
// Client frames after which the response is over (both clients' terminal events).
const TERMINAL_FRAME =
  /^event: (?:message_stop|error|response\.(?:completed|incomplete|failed))\r?\n/;

const count = (record, name) => {
  record[name] = (record[name] ?? 0) + 1;
};

const hasImage = (parts) =>
  parts.some(
    (part) =>
      part.type === "image" || (part.type === "toolResult" && hasImage(part.parts)),
  );

function irHasImage(ir) {
  return hasImage(ir.system) || ir.messages.some((message) => hasImage(message.parts));
}

/** Upstream `ctx.model`: the builders and parsers read `id`, `outputTokens`, … */
function upstreamModel(model) {
  if (!model || typeof model !== "object") return undefined;
  return { ...model, id: model.modelId };
}

/** Wraps an error thrown by the caller's chunk iterator (idle timeout, socket reset, …). */
class TransportFailure extends Error {
  constructor(cause) {
    super("the upstream transport failed");
    this.name = "TransportFailure";
    this.cause = cause;
  }
}

/** SSE events of the upstream chunks; iterator failures surface as TransportFailure. */
async function* sseEvents(chunks) {
  const parser = createSseParser();
  const iterator =
    typeof chunks?.[Symbol.asyncIterator] === "function"
      ? chunks[Symbol.asyncIterator]()
      : chunks[Symbol.iterator]();
  let finished = false;
  try {
    for (;;) {
      let next;
      try {
        next = await iterator.next();
      } catch (cause) {
        finished = true;
        throw new TransportFailure(cause);
      }
      if (next.done) {
        finished = true;
        break;
      }
      yield* parser.push(next.value);
    }
  } finally {
    if (!finished) await iterator.return?.();
  }
  yield* parser.end();
}

async function* fromArray(events) {
  yield* events;
}

function validateRoute(client, upstream) {
  if (!Object.hasOwn(CLIENTS, client)) {
    throw new TypeError(`client: unsupported protocol ${String(client)}`);
  }
  if (!Object.hasOwn(UPSTREAMS, upstream)) {
    throw new TypeError(`upstream: unsupported protocol ${String(upstream)}`);
  }
  if (client === upstream) {
    throw new TypeError("upstream: native routes do not use the adapter");
  }
}

export function createTranslator({
  client,
  upstream,
  model,
  capabilities = {},
  thinkTagExtraction = false,
  sessionKey = "",
  secrets = [],
} = {}) {
  validateRoute(client, upstream);
  const clientSide = CLIENTS[client];
  const upstreamSide = UPSTREAMS[upstream];
  const session = {
    names: createNameMap(upstreamSide.names),
    ids: createIdMap(CALL_ID),
    capabilities: resolveCapabilities(upstream, capabilities),
    model: upstreamModel(model),
    sessionKey,
    thinkTagExtraction: thinkTagExtraction === true,
  };
  const stats = { dropped: {}, adjustments: {}, errors: {}, estimatedUsage: 0 };
  let cacheReadTokens = 0;

  const secretList = (Array.isArray(secrets) ? secrets : []).filter(
    (secret) => typeof secret === "string",
  );

  /** Client rendering of an IrError before any client output was written. */
  function renderError(error, { streaming, context }) {
    if (client === "messages") {
      const rendered = messagesErrorBody(error);
      return {
        ...rendered,
        headers: { "content-type": "application/json", ...rendered.headers },
      };
    }
    if (streaming) {
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: responsesErrorStream(error, context),
      };
    }
    const rendered = responsesErrorBody(error);
    return {
      ...rendered,
      headers: { "content-type": "application/json", ...rendered.headers },
    };
  }

  const clean = (error) => ({
    ...error,
    message: sanitizeMessage(error.message, secretList) || "upstream error",
  });

  /**
   * Per-request upstream context: the session's maps, capabilities and model plus the
   * request id, the redaction list and (after building) the serialized request size. The
   * same object is passed to the upstream builder and to its stream/response parsers.
   */
  const requestContext = (state) => ({
    ...session,
    secrets: secretList,
    requestId: state.requestId,
    requestChars: 0,
  });

  function createExchange(state, ctx = requestContext(state)) {
    const context = contextOf(state);
    // Client frames handed out so far (Responses `sequence_number` of the next frame).
    let frames = 0;
    // A terminal frame handed out in-stream ends the client stream; nothing follows it.
    let terminated = false;
    const emitOptions =
      client === "messages"
        ? {
            model: state.clientModel,
            messageId: state.requestId,
            display: state.display,
            origin: upstream,
          }
        : {
            model: state.clientModel,
            responseId: state.requestId,
            includeEncrypted: state.includeEncrypted,
            origin: upstream,
            customTools: state.customTools,
            createdAt: state.createdAt,
          };

    let estimated = false;
    let cacheRead = 0; // usage is cumulative: count each exchange's highest value once
    async function* observe(events) {
      for await (const event of events) {
        if (event.type === "usage" && event.cacheRead > cacheRead) {
          cacheReadTokens += event.cacheRead - cacheRead;
          cacheRead = event.cacheRead;
        }
        if (event.type === "usage" && event.estimated && !estimated) {
          estimated = true;
          stats.estimatedUsage += 1;
        }
        yield event.type === "error" ? { ...event, error: clean(event.error) } : event;
      }
    }

    /** In-stream error text numbered from the frames written so far. */
    function inStreamError(error) {
      if (client === "messages") {
        frames += 1;
        return messagesErrorEvent(error);
      }
      if (frames === 0) {
        frames = 2;
        return responsesErrorStream(error, context);
      }
      const frame = responsesFailedEvent(error, { ...context, sequenceNumber: frames });
      frames += 1;
      return frame;
    }

    /**
     * Client error for an IrError: an in-stream frame once frames were written or when
     * `started` (headers sent), else the full rendering (HTTP body or Codex error stream).
     */
    function render(error, { streaming, started } = {}) {
      if (terminated) return null;
      if (frames > 0 || started === true) {
        terminated = true;
        return inStreamError(error);
      }
      return renderError(error, { streaming: streaming ?? state.streaming, context });
    }

    async function* translateStream(chunks, { silent } = {}) {
      let error;
      try {
        const events = observe(upstreamSide.parseStream(sseEvents(chunks), ctx));
        for await (const frame of clientSide.emitStream(events, emitOptions)) {
          frames += 1;
          if (TERMINAL_FRAME.test(frame)) terminated = true;
          yield frame;
        }
        return;
      } catch (cause) {
        if (cause instanceof TransportFailure) {
          error = classifyTransportError(cause.cause, secretList);
          if (!silent?.()) count(stats.errors, `stream.${error.kind}`);
        } else {
          error = INVALID_STREAM;
          count(stats.errors, "stream.invalid");
        }
      }
      if (terminated) return;
      terminated = true;
      yield inStreamError(clean(error));
    }

    async function translateResponse(json) {
      let failure;
      try {
        const events = observe(fromArray(upstreamSide.parseResponse(json, ctx)));
        return await clientSide.emitResponse(events, emitOptions);
      } catch (cause) {
        if (cause instanceof AdapterUpstreamError) failure = cause;
        else if (cause instanceof TypeError || cause instanceof RangeError) {
          count(stats.errors, "response.invalid");
          failure = new AdapterUpstreamError(INVALID_RESPONSE);
        } else throw cause;
      }
      failure.clientError = renderError(failure.error, { streaming: false, context });
      throw failure;
    }

    function translateError({ status, body, headers } = {}, options = {}) {
      const error = classifyUpstreamError({
        protocol: upstream,
        status,
        body,
        headers,
        now: options.now ?? state.now,
        secrets: secretList,
      });
      return render(error, options);
    }

    /** Adapter-local failure (idle timeout, connect error, …) rendered for the client. */
    const fail = (error, options = {}) => render(clean(error), options);

    const keepalive = () =>
      client === "messages" ? messagesPing() : responsesKeepalive(state.requestId);

    return {
      translateStream,
      translateResponse,
      translateError,
      fail,
      keepalive,
      get terminated() {
        return terminated;
      },
    };
  }

  const contextOf = (state) => ({
    responseId: state.requestId,
    model: state.clientModel,
    createdAt: state.createdAt,
  });

  function nextState(options, ir, streaming) {
    const requestId = options.requestId;
    const now = Number.isFinite(options.now) ? options.now : undefined;
    return {
      requestId,
      now,
      createdAt: now === undefined ? undefined : Math.floor(now / 1000),
      streaming,
      clientModel: ir?.model ?? "",
      display: ir?.thinking?.display,
      includeEncrypted:
        Array.isArray(ir?.hints?.include) &&
        ir.hints.include.includes(ENCRYPTED_REASONING),
      customTools: (ir?.tools ?? [])
        .filter((tool) => tool.kind === "custom")
        .map(({ name, namespace }) => (namespace ? { name, namespace } : { name })),
    };
  }

  function reject(error, state) {
    return {
      ok: false,
      error: renderError(clean(error), {
        streaming: state.streaming,
        context: contextOf(state),
      }),
      exchange: createExchange(state),
    };
  }

  const invalid = (message) => ({ kind: "invalidRequest", status: 400, message });

  function buildUpstream(body, headers = {}, options = {}) {
    if (typeof options?.requestId !== "string" || options.requestId === "") {
      throw new TypeError("buildUpstream: options.requestId must be a non-empty string");
    }
    const streaming = body?.stream === true;
    let parsed;
    try {
      parsed = clientSide.parse(body, headers);
    } catch (cause) {
      if (!(cause instanceof TypeError)) throw cause;
      count(stats.errors, "request.invalid");
      return reject(invalid(cause.message), nextState(options, null, streaming));
    }
    const { ir } = parsed;
    const state = nextState(options, ir, streaming);
    if (parsed.rejected) {
      count(stats.errors, "request.rejected");
      return reject(parsed.rejected, state);
    }
    if (session.model?.images === false && irHasImage(ir)) {
      count(stats.errors, "request.imageRejected");
      return reject(invalid(NO_IMAGES), state);
    }
    for (const tool of ir.tools) session.names.toUpstream(tool.name, tool.namespace);
    const ctx = requestContext(state);
    let built;
    try {
      built = upstreamSide.build(ir, ctx);
    } catch (cause) {
      if (!(cause instanceof TypeError)) throw cause;
      count(stats.errors, "request.invalid");
      return reject(invalid(cause.message), state);
    }
    const dropped = [...new Set([...(parsed.dropped ?? []), ...(built.dropped ?? [])])];
    for (const name of dropped) count(stats.dropped, name);
    for (const name of built.adjustments ?? []) count(stats.adjustments, name);
    ctx.requestChars = JSON.stringify(built.body).length;
    const exchange = createExchange(state, ctx);
    return {
      ok: true,
      request: {
        path: built.path,
        body: built.body,
        headers: { "content-type": "application/json", ...(built.headers ?? {}) },
      },
      dropped,
      exchange,
    };
  }

  /** Changes one capability for subsequent `buildUpstream` calls (capability retry). */
  function setCapability(name, value) {
    assertCapability(upstream, name, value);
    // A new object: exchanges of earlier requests keep the capabilities they were built with.
    session.capabilities = { ...session.capabilities, [name]: value };
  }

  return {
    buildUpstream,
    setCapability,
    diagnostics: () => ({
      dropped: { ...stats.dropped },
      adjustments: { ...stats.adjustments },
      errors: { ...stats.errors },
      estimatedUsage: stats.estimatedUsage,
      cacheReadTokens,
    }),
  };
}
