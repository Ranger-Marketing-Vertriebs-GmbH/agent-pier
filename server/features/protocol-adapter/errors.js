// Upstream error classification into IrError and the client-specific error renderings
// (Anthropic Messages for Claude Code, OpenAI Responses for Codex). Pure: time is passed in.

import { sseEvent } from "./sse.js";

/**
 * Rejection of the non-streaming emitters (and `exchange.translateResponse`) when the
 * upstream reported an error: `error` is the IrError.
 */
export class AdapterUpstreamError extends Error {
  constructor(error) {
    super(error.message);
    this.name = "AdapterUpstreamError";
    this.error = error;
  }
}

const MAX_MESSAGE = 500;
const REDACTED = "[redacted]";

const STATUS_KINDS = Object.freeze({
  400: "invalidRequest",
  401: "auth",
  402: "permission",
  403: "permission",
  404: "notFound",
  408: "timeout",
  429: "rateLimit",
  503: "overloaded",
  504: "timeout",
  529: "overloaded",
});

// Anthropic `error.type` and OpenAI `error.code`/`error.type` values.
const TYPE_KINDS = Object.freeze({
  invalid_request_error: "invalidRequest",
  request_too_large: "invalidRequest",
  invalid_prompt: "invalidRequest",
  authentication_error: "auth",
  invalid_api_key: "auth",
  permission_error: "permission",
  billing_error: "permission",
  insufficient_quota: "permission",
  not_found_error: "notFound",
  model_not_found: "notFound",
  rate_limit_error: "rateLimit",
  rate_limit_exceeded: "rateLimit",
  slow_down: "rateLimit",
  overloaded_error: "overloaded",
  server_is_overloaded: "overloaded",
  api_error: "server",
  server_error: "server",
  timeout_error: "timeout",
  // Responses `response.failed` codes Codex treats as fatal (facts §3.8).
  credit_balance_exhausted: "permission",
  usage_not_included: "permission",
  cyber_policy: "invalidRequest",
  bio_policy: "invalidRequest",
  misalignment_policy_violation: "invalidRequest",
});

// Codes that mean "not retryable" even when the status says otherwise (OpenAI quota 429).
const OVERRIDING_CODES = Object.freeze({ insufficient_quota: "permission" });

// Unknown status-less codes that read as a rejection of the request (policy, validation,
// unsupported feature): retrying cannot help, so they are not reported as `server` errors.
const NON_RETRYABLE_CODE = /polic|^invalid_|unsupported|not_supported|content_filter/;

const CONTEXT_PATTERNS = [
  /prompt is too long/i,
  /input is too long for requested model/i,
  /capability_rejected: prompt_too_long/i,
  /input length and `max_tokens` exceed context limit/i,
  /maximum context length is/i,
  /exceeds the available context size/i,
  /is larger than the max context size/i,
  /context the overflows|greater than the context length/i,
  /ContextWindowExceededError/,
  /exceeds the context window/i,
];

// Each recognizer fills the token numbers it can read; the first value found wins.
const NUMBER_PATTERNS = [
  [
    /input length and `max_tokens` exceed context limit:\s*(\d+)\s*\+\s*(\d+)\s*>\s*(\d+)/i,
    ["promptTokens", "outputTokens", "contextWindow"],
  ],
  [
    /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i,
    ["promptTokens", "contextWindow"],
  ],
  [/maximum context length is (\d+) tokens/i, ["contextWindow"]],
  [/prompt contains (?:at least )?(\d+) input tokens/i, ["promptTokens"]],
  [/you requested (\d+) output tokens/i, ["outputTokens"]],
  [
    /\((\d+) in the messages, (\d+) in the completion\)/i,
    ["promptTokens", "outputTokens"],
  ],
  [/messages resulted in (\d+) tokens/i, ["promptTokens"]],
  [
    /(?:request|input) \((\d+) tokens\) (?:exceeds the available|is larger than the max) context size \((\d+) tokens\)/i,
    ["promptTokens", "contextWindow"],
  ],
  [
    /keep the first (\d+) tokens[\s\S]*?context length of only (\d+) tokens/i,
    ["promptTokens", "contextWindow"],
  ],
];

const TRY_AGAIN = /try again in\s*(\d+(?:\.\d+)?)\s*(ms|s|seconds?)\b/i;

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmpty = (value) =>
  typeof value === "string" && value !== "" ? value : undefined;
const symbolic = (value) =>
  typeof value === "string" && value !== "" && !/^\d+$/.test(value) ? value : undefined;

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Message safe for clients: secrets redacted, control characters removed, ≤ 500 chars. */
export function sanitizeMessage(text, secrets = []) {
  let result = typeof text === "string" ? text : text == null ? "" : String(text);
  const ordered = [...new Set(secrets.filter((secret) => nonEmpty(secret)))].sort(
    (a, b) => b.length - a.length,
  );
  for (const secret of ordered) {
    result = result.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  result = result
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED)
    .replace(/[\t\n\r]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  return result.slice(0, MAX_MESSAGE);
}

function parseBody(body) {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/** Finds the error object of every supported envelope (HTTP bodies and in-stream errors). */
function errorFields(rawBody) {
  const body = parseBody(rawBody);
  if (typeof body === "string") return { message: body, details: {} };
  if (!isObject(body)) return { details: {} };
  const candidate = isObject(body.response?.error)
    ? body.response.error
    : isObject(body.error)
      ? body.error
      : typeof body.error === "string"
        ? { message: body.error }
        : body;
  return {
    message: nonEmpty(candidate.message) ?? nonEmpty(candidate.detail),
    type: symbolic(candidate.type),
    code: symbolic(candidate.code),
    statusCode: httpCode(candidate.code),
    details: candidate,
  };
}

/** vLLM/LiteLLM put the HTTP status into `error.code` (integer or digit string). */
function httpCode(value) {
  const number =
    typeof value === "string" && /^\d{3}$/.test(value) ? Number(value) : value;
  return Number.isInteger(number) && number >= 400 && number <= 599 ? number : null;
}

function isContextOverflow({ status, message = "", type, code }) {
  if (Number.isInteger(status) && (status < 400 || status >= 500)) return false;
  if (code === "context_length_exceeded" || type === "exceed_context_size_error") {
    return true;
  }
  if (status === 413 && /context window/i.test(message)) return true;
  return CONTEXT_PATTERNS.some((pattern) => pattern.test(message));
}

function contextNumbers(message = "", details) {
  const numbers = {};
  for (const [pattern, names] of NUMBER_PATTERNS) {
    const match = pattern.exec(message);
    if (!match) continue;
    names.forEach((name, index) => {
      numbers[name] ??= Number(match[index + 1]);
    });
  }
  if (Number.isInteger(details.n_prompt_tokens))
    numbers.promptTokens = details.n_prompt_tokens;
  if (Number.isInteger(details.n_ctx)) numbers.contextWindow = details.n_ctx;
  return numbers;
}

function kindFor({ status, type, code }) {
  if (OVERRIDING_CODES[code]) return OVERRIDING_CODES[code];
  if (Number.isInteger(status)) {
    if (STATUS_KINDS[status]) return STATUS_KINDS[status];
    if (status >= 500) return "server";
    if (status >= 400) return "invalidRequest";
  }
  const known = TYPE_KINDS[code] ?? TYPE_KINDS[type];
  if (known) return known;
  return NON_RETRYABLE_CODE.test(code ?? "") ? "invalidRequest" : "server";
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

/** `retry-after` value in seconds: delta-seconds, or an HTTP date relative to `now` (ms). */
export function parseRetryAfter(value, now) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const reference = Number(now);
  const date = Date.parse(text);
  if (!Number.isFinite(reference) || Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - reference) / 1000));
}

function retryAfterFrom(headers, now, kind, message = "") {
  const millis = headerValue(headers, "retry-after-ms");
  if (millis !== undefined && /^\d+(?:\.\d+)?$/.test(String(millis).trim())) {
    return Number(millis) / 1000;
  }
  const header = parseRetryAfter(headerValue(headers, "retry-after"), now);
  if (header !== undefined || kind !== "rateLimit") return header;
  const match = TRY_AGAIN.exec(message);
  if (!match) return undefined;
  return match[2].toLowerCase() === "ms" ? Number(match[1]) / 1000 : Number(match[1]);
}

/**
 * Classifies an upstream error (HTTP response or status-less in-stream error) as IrError.
 * `protocol` is the upstream family; envelopes of all three families are recognized.
 * Only `retry-after`/`retry-after-ms` headers are read; nothing else from headers leaks.
 */
export function classifyUpstreamError({
  protocol, // eslint-disable-line no-unused-vars -- envelopes are detected structurally
  status,
  body,
  headers,
  now,
  secrets = [],
} = {}) {
  const fields = errorFields(body);
  // Status-less errors (in-stream, or a 200 body) fall back to a numeric `error.code`.
  const httpStatus = Number.isInteger(status) ? status : (fields.statusCode ?? null);
  const probe = { ...fields, status: httpStatus };
  const context = isContextOverflow(probe);
  const kind = context ? "contextLength" : kindFor(probe);
  const fallback =
    httpStatus === null ? "Upstream error" : `Upstream returned HTTP ${httpStatus}`;
  const error = {
    kind,
    status: httpStatus,
    message: sanitizeMessage(fields.message, secrets) || fallback,
  };
  // OpenAI-style `param` names the rejected parameter (capability retry, capabilities.js).
  const param = nonEmpty(fields.details.param);
  if (param) error.param = sanitizeMessage(param, secrets).slice(0, 100);
  const retryAfter = retryAfterFrom(headers, now, kind, fields.message);
  if (retryAfter !== undefined) error.retryAfter = retryAfter;
  if (context) Object.assign(error, contextNumbers(fields.message, fields.details));
  return error;
}

const DEFAULT_MESSAGES = Object.freeze({
  auth: "authentication failed",
  permission: "permission denied",
  notFound: "not found",
  rateLimit: "rate limit reached",
  overloaded: "overloaded",
  invalidRequest: "invalid request",
  contextLength: "prompt is too long",
  server: "server error",
  timeout: "upstream timed out",
  network: "upstream unreachable",
});

const TIMEOUT_NAMES = new Set(["AbortError", "TimeoutError"]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

const isTimeout = (error) =>
  isObject(error) && (TIMEOUT_NAMES.has(error.name) || TIMEOUT_CODES.has(error.code));

/**
 * IrError for a failure of the upstream transport itself (no HTTP response, or a broken
 * response stream): `timeout` for aborts and timeouts (the caller's idle timer aborts the
 * fetch), `network` for socket errors and everything else. An `adapterKind` property on
 * the error (any IrError kind) wins, so the caller can classify its own failures.
 */
export function classifyTransportError(error, secrets = []) {
  const hint = isObject(error) ? error.adapterKind : undefined;
  let kind;
  if (typeof hint === "string" && Object.hasOwn(DEFAULT_MESSAGES, hint)) kind = hint;
  else if (isTimeout(error) || isTimeout(error?.cause)) kind = "timeout";
  else kind = "network";
  // An abort's own message ("This operation was aborted") says less than the default.
  const detail = kind === "timeout" && hint === undefined ? undefined : error?.message;
  return {
    kind,
    status: null,
    message: sanitizeMessage(detail, secrets) || DEFAULT_MESSAGES[kind],
  };
}

// Renderers sanitize again (defense in depth): an IrError may come from another producer
// than the classifiers above, so its message is never trusted to be clean.
const messageOf = (error) =>
  sanitizeMessage(nonEmpty(error.message)) ||
  DEFAULT_MESSAGES[error.kind] ||
  DEFAULT_MESSAGES.server;

function retryHeaders(error) {
  if (!Number.isFinite(error.retryAfter)) return {};
  return { "retry-after": String(Math.max(0, Math.ceil(error.retryAfter))) };
}

const MESSAGES_ERRORS = Object.freeze({
  auth: [401, "authentication_error"],
  permission: [403, "permission_error"],
  notFound: [404, "not_found_error"],
  rateLimit: [429, "rate_limit_error"],
  overloaded: [529, "overloaded_error"],
  invalidRequest: [400, "invalid_request_error"],
  contextLength: [400, "invalid_request_error"],
  server: [500, "api_error"],
  timeout: [504, "timeout_error"],
  network: [502, "api_error"],
});

// Claude Code retries a max_tokens overflow with max_tokens = max - prompt - 1000 and only
// when that leaves at least 3000 tokens; otherwise it gives up instead of compacting.
const SHRINK_MARGIN = 1000;
const MIN_SHRUNK_OUTPUT = 3000;

/**
 * Claude Code's wording: it compacts on "prompt is too long" and shrinks `max_tokens` on
 * "input length and `max_tokens` exceed context limit". The latter is used only when the
 * shrunk output budget is usable; otherwise the total is reported as too long.
 */
function contextWording({
  promptTokens: prompt,
  outputTokens: output,
  contextWindow: max,
}) {
  const known = (value) => Number.isInteger(value);
  if (!known(prompt) || !known(max)) return "prompt is too long";
  if (known(output) && prompt <= max) {
    if (max - prompt - SHRINK_MARGIN >= MIN_SHRUNK_OUTPUT) {
      return (
        `input length and \`max_tokens\` exceed context limit: ${prompt} + ${output} > ${max}, ` +
        "decrease input length or `max_tokens` and try again"
      );
    }
    return `prompt is too long: ${prompt + output} tokens > ${max} maximum`;
  }
  return `prompt is too long: ${prompt} tokens > ${max} maximum`;
}

function messagesError(error) {
  const [status, type] = MESSAGES_ERRORS[error.kind] ?? MESSAGES_ERRORS.server;
  const message =
    error.kind === "contextLength" ? contextWording(error) : messageOf(error);
  return { status, payload: { type: "error", error: { type, message } } };
}

/** HTTP error response for the Messages client (no request ids, only `retry-after`). */
export function messagesErrorBody(error) {
  const { status, payload } = messagesError(error);
  return { status, body: payload, headers: retryHeaders(error) };
}

/** In-stream `event: error` for the Messages client. */
export function messagesErrorEvent(error) {
  return sseEvent("error", messagesError(error).payload);
}

const RESPONSES_ERRORS = Object.freeze({
  auth: [401, "invalid_request_error", "invalid_api_key"],
  permission: [403, "invalid_request_error", null],
  notFound: [404, "invalid_request_error", null],
  rateLimit: [429, "rate_limit_error", "rate_limit_exceeded"],
  overloaded: [503, "server_error", "server_error"],
  invalidRequest: [400, "invalid_request_error", null],
  contextLength: [400, "invalid_request_error", "context_length_exceeded"],
  server: [500, "server_error", "server_error"],
  timeout: [504, "server_error", "server_error"],
  network: [502, "server_error", "server_error"],
});

/** HTTP error response for the Responses client (auth failures and `stream: false`). */
export function responsesErrorBody(error) {
  const [status, type, code] = RESPONSES_ERRORS[error.kind] ?? RESPONSES_ERRORS.server;
  return {
    status,
    body: { error: { message: messageOf(error), type, param: null, code } },
    headers: retryHeaders(error),
  };
}

// Codex retries `server_error` and `rate_limit_exceeded`, stops on `invalid_prompt` and
// compacts on `context_length_exceeded`; `server_is_overloaded` is never retried, so unused.
const RESPONSES_STREAM_CODES = Object.freeze({
  contextLength: "context_length_exceeded",
  rateLimit: "rate_limit_exceeded",
  overloaded: "server_error",
  server: "server_error",
  timeout: "server_error",
  network: "server_error",
  invalidRequest: "invalid_prompt",
  notFound: "invalid_prompt",
  auth: "invalid_prompt",
  permission: "invalid_prompt",
});

function streamMessage(error) {
  if (error.kind !== "rateLimit") return messageOf(error);
  const seconds = Number.isFinite(error.retryAfter) ? Math.ceil(error.retryAfter) : 1;
  return `Rate limit reached. Please try again in ${Math.max(1, seconds)}s.`;
}

/** Minimal Responses `response` object shared by created, failed and completed events. */
export function responseShell({ responseId, model, createdAt }, status) {
  const response = { id: responseId, object: "response" };
  if (Number.isFinite(createdAt)) response.created_at = createdAt;
  return { ...response, model, status, output: [] };
}

/** `response.failed` event for a Responses stream that has already started. */
export function responsesFailedEvent(error, { sequenceNumber = 1, ...context } = {}) {
  return sseEvent("response.failed", {
    type: "response.failed",
    sequence_number: sequenceNumber,
    response: {
      ...responseShell(context, "failed"),
      error: {
        code: RESPONSES_STREAM_CODES[error.kind] ?? "server_error",
        message: streamMessage(error),
      },
    },
  });
}

/** Complete error stream for Codex: `response.created` then `response.failed`. */
export function responsesErrorStream(error, context = {}) {
  const created = sseEvent("response.created", {
    type: "response.created",
    sequence_number: 0,
    response: responseShell(context, "in_progress"),
  });
  return created + responsesFailedEvent(error, { ...context, sequenceNumber: 1 });
}
