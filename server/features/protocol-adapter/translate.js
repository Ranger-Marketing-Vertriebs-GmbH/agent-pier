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
 * - `capabilities`: the connection's `adapterCapabilities` for the upstream protocol.
 * - `sessionKey`: stable per-session string (prompt cache key fallback).
 * - `secrets`: strings redacted from every message that reaches the client.
 *
 * One tool-name map and one call-id map live per translator (= per session); both use the
 * upstream's patterns, and the IR's tools are registered in IR order on every request so
 * the mapping is stable for the whole session.
 *
 * Methods of the translator: `buildUpstream` and `diagnostics`. Everything that
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
 * - `diagnostics()`: `{ dropped, adjustments, estimatedUsage }`: counters by name and the
 *   number of responses whose usage was estimated.
 *
 * Exchange methods:
 * - `translateStream(chunks)`: upstream SSE text chunks (AsyncIterable<string>) → client
 *   SSE text (AsyncIterable<string>). Upstream errors and malformed streams end in the
 *   client's in-stream error (Messages `event: error`, Responses `response.failed` with
 *   the correct `sequence_number`); malformed streams count as `stream.invalid`.
 * - `translateResponse(json)`: non-streaming upstream body → Promise of the client body.
 *   Rejects with `AdapterUpstreamError` carrying `error` (IrError) and `clientError`
 *   (`{ status, headers, body }` rendered for the client) when the body is an error or
 *   cannot be translated (a server error, counted as `response.invalid`).
 * - `translateError({ status, body, headers }, { streaming, started, now })`: upstream
 *   HTTP error → client rendering. `streaming`: the client asked for a stream (defaults
 *   to the request's `stream`); `started`: the client response has already begun
 *   (headers sent), so only an in-stream frame (string) can be written. Messages client:
 *   HTTP body unless `started`. Responses client: `stream: true` errors are HTTP 200 SSE
 *   (`response.created` + `response.failed`, Amendment 3), `stream: false` errors are
 *   HTTP bodies. Caveat: with `started: true` the Codex `response.failed` frame carries
 *   `sequence_number: 1`, because the translator does not know how many frames the
 *   caller wrote; mid-stream failures should go through `translateStream`, which numbers
 *   them correctly.
 * - `keepalive()`: Messages `event: ping` or Responses `response.in_progress` frame.
 */

import {
  AdapterUpstreamError,
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

async function* sseEvents(chunks) {
  const parser = createSseParser();
  for await (const chunk of chunks) yield* parser.push(chunk);
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
    capabilities: { ...capabilities },
    model: upstreamModel(model),
    sessionKey,
    thinkTagExtraction: thinkTagExtraction === true,
  };
  const stats = { dropped: {}, adjustments: {}, estimatedUsage: 0 };

  const secretList = secrets.filter((secret) => typeof secret === "string");

  /** Client rendering of an IrError before any client output was written. */
  function renderError(error, { streaming, started, context, sequenceNumber }) {
    if (client === "messages") {
      if (started) return messagesErrorEvent(error);
      const rendered = messagesErrorBody(error);
      return {
        ...rendered,
        headers: { "content-type": "application/json", ...rendered.headers },
      };
    }
    if (started) return responsesFailedEvent(error, { ...context, sequenceNumber });
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

  function createExchange(state) {
    const ctx = { ...session, requestChars: state.requestChars };
    const context = {
      responseId: state.requestId,
      model: state.clientModel,
      createdAt: state.createdAt,
    };
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
    async function* observe(events) {
      for await (const event of events) {
        if (event.type === "usage" && event.estimated && !estimated) {
          estimated = true;
          stats.estimatedUsage += 1;
        }
        yield event.type === "error" ? { ...event, error: clean(event.error) } : event;
      }
    }

    async function* translateStream(chunks) {
      let frames = 0;
      try {
        const events = observe(upstreamSide.parseStream(sseEvents(chunks), ctx));
        for await (const frame of clientSide.emitStream(events, emitOptions)) {
          frames += 1;
          yield frame;
        }
      } catch (cause) {
        if (!(cause instanceof TypeError || cause instanceof RangeError)) throw cause;
        count(stats.dropped, "stream.invalid");
        if (client === "messages") yield messagesErrorEvent(INVALID_STREAM);
        else if (frames === 0) yield responsesErrorStream(INVALID_STREAM, context);
        else
          yield responsesFailedEvent(INVALID_STREAM, {
            ...context,
            sequenceNumber: frames,
          });
      }
    }

    async function translateResponse(json) {
      let failure;
      try {
        const events = observe(fromArray(upstreamSide.parseResponse(json, ctx)));
        return await clientSide.emitResponse(events, emitOptions);
      } catch (cause) {
        if (cause instanceof AdapterUpstreamError) failure = cause;
        else if (cause instanceof TypeError || cause instanceof RangeError) {
          count(stats.dropped, "response.invalid");
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
      return renderError(error, {
        streaming: options.streaming ?? state.streaming,
        started: options.started === true,
        context,
        sequenceNumber: 1,
      });
    }

    const keepalive = () =>
      client === "messages" ? messagesPing() : responsesKeepalive(state.requestId);

    return { translateStream, translateResponse, translateError, keepalive };
  }

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
      requestChars: 0,
    };
  }

  function reject(error, state) {
    const exchange = createExchange(state);
    const context = {
      responseId: state.requestId,
      model: state.clientModel,
      createdAt: state.createdAt,
    };
    return {
      ok: false,
      error: renderError(clean(error), { streaming: state.streaming, context }),
      exchange,
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
      count(stats.dropped, "request.invalid");
      return reject(invalid(cause.message), nextState(options, null, streaming));
    }
    const { ir } = parsed;
    const state = nextState(options, ir, streaming);
    if (parsed.rejected) {
      count(stats.dropped, "request.rejected");
      return reject(parsed.rejected, state);
    }
    if (session.model?.images === false && irHasImage(ir)) {
      count(stats.dropped, "request.imageRejected");
      return reject(invalid(NO_IMAGES), state);
    }
    for (const tool of ir.tools) session.names.toUpstream(tool.name, tool.namespace);
    let built;
    try {
      built = upstreamSide.build(ir, session);
    } catch (cause) {
      if (!(cause instanceof TypeError)) throw cause;
      count(stats.dropped, "request.invalid");
      return reject(invalid(cause.message), state);
    }
    const dropped = [...new Set([...(parsed.dropped ?? []), ...(built.dropped ?? [])])];
    for (const name of dropped) count(stats.dropped, name);
    for (const name of built.adjustments ?? []) count(stats.adjustments, name);
    const serialized = JSON.stringify(built.body);
    state.requestChars = serialized.length;
    const exchange = createExchange(state);
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

  return {
    buildUpstream,
    diagnostics: () => ({
      dropped: { ...stats.dropped },
      adjustments: { ...stats.adjustments },
      estimatedUsage: stats.estimatedUsage,
    }),
  };
}
