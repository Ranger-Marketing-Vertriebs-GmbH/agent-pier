import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import {
  ENV_PROXY_MINIMUM_NODE,
  envProxySupported,
  proxyRouted,
} from "../../lib/proxy-environment.js";

export const DOWNLOAD_IDLE_TIMEOUT = 30000;
export const downloadRetryDelay = (attempt) => 1000 * 2 ** attempt;
const transient = Symbol("transient download failure");
/** Marks a transport failure as worth another attempt. */
function retryLater(error) {
  if (error && typeof error === "object") error[transient] = true;
  return error;
}
const failure = (message, code, status) =>
  Object.assign(problem(message, status), { code });
const idleFailure = () =>
  retryLater(
    failure(serverMessages.releases.downloadStalled, "DOWNLOAD_IDLE_TIMEOUT", 504),
  );
const rangeFailure = () =>
  retryLater(
    failure(serverMessages.releases.downloadFailed, "DOWNLOAD_RANGE_MISMATCH", 502),
  );
// Network and body failures from fetch are TypeErrors with a cause; a TypeError
// without one is a programming error and is never retried.
const transport = (error) =>
  error instanceof TypeError && !error.cause ? error : retryLater(error);
// Only a strong validator proves a resumed range belongs to the same file.
function validator(headers) {
  const etag = headers.get("etag");
  if (etag && !etag.startsWith("W/")) return etag;
  return headers.get("last-modified") || null;
}
const reset = (state) => Object.assign(state, { chunks: [], length: 0, validator: null });
const contentRange = (response) =>
  /^bytes (?:(\d+)-(\d+)|\*)\/(\d+|\*)$/.exec(
    response.headers.get("content-range") || "",
  );

/**
 * Downloads an HTTPS resource into memory. Only a transfer that receives no bytes
 * for `idleTimeout` is aborted; slow links finish. Network failures, idle transfers
 * and server errors are retried up to `retries` times; a retry resumes with a range
 * request only when the first response carried a strong validator.
 */
export async function download(
  url,
  fetchImpl,
  limit,
  {
    idleTimeout = DOWNLOAD_IDLE_TIMEOUT,
    retries = 3,
    retryDelay = downloadRetryDelay,
    environment = process.env,
    nodeVersion = process.versions.node,
  } = {},
) {
  // Older Node releases ignore NODE_USE_ENV_PROXY and would bypass the proxy.
  if (proxyRouted(environment) && !envProxySupported(nodeVersion))
    throw failure(
      serverMessages.releases.proxyRequiresNewerNode(ENV_PROXY_MINIMUM_NODE),
      "PROXY_REQUIRES_NEWER_NODE",
      503,
    );
  const state = reset({});
  for (let attempt = 0; ; attempt++) {
    try {
      await transfer(url, fetchImpl, limit, idleTimeout, state);
      return Buffer.concat(state.chunks, state.length);
    } catch (error) {
      if (attempt >= retries || error?.[transient] !== true) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelay(attempt)));
    }
  }
}

async function transfer(url, fetchImpl, limit, idleTimeout, state) {
  if (!state.validator) reset(state);
  const controller = new AbortController();
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(idleFailure()), idleTimeout);
  };
  const aborted = new Promise((_, reject) =>
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
      once: true,
    }),
  );
  aborted.catch(() => {});
  const idle = (promise) =>
    Promise.race([promise.catch((e) => Promise.reject(transport(e))), aborted]);
  let response, reader;
  arm();
  try {
    const headers = state.length
      ? { range: `bytes=${state.length}-`, "if-range": state.validator }
      : null;
    for (let redirect = 0; redirect <= 5; redirect++) {
      const target = new URL(url);
      if (target.protocol !== "https:" || target.username || target.password)
        throw problem(serverMessages.releases.httpsDownloadRequired);
      response = await idle(
        fetchImpl(target.href, {
          signal: controller.signal,
          redirect: "manual",
          ...(headers ? { headers } : {}),
        }),
      );
      arm();
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      if (redirect === 5 || !response.headers.get("location"))
        throw problem(serverMessages.releases.redirectLimit);
      url = new URL(response.headers.get("location"), target).href;
      await response.body?.cancel();
    }
    if (response.status === 416 && state.length) {
      // The earlier attempt already received the whole file.
      const range = contentRange(response);
      await response.body?.cancel();
      if (range && !range[1] && Number(range[3]) === state.length) return;
      reset(state);
      throw rangeFailure();
    }
    if (!response.ok) {
      const error = problem(
        serverMessages.releases.downloadFailed,
        response.status === 404 ? 404 : 502,
      );
      if (response.status >= 500) retryLater(error);
      throw error;
    }
    if (response.status === 206) {
      const range = contentRange(response);
      if (
        !state.length ||
        !range?.[1] ||
        Number(range[1]) !== state.length ||
        (range[3] !== "*" && Number(range[2]) + 1 !== Number(range[3]))
      ) {
        // A range that does not continue the received bytes: start again from zero.
        await response.body?.cancel();
        reset(state);
        throw rangeFailure();
      }
    } else {
      // A full response replaces whatever an earlier attempt received.
      reset(state);
      state.validator = validator(response.headers);
    }
    if (state.length + Number(response.headers.get("content-length")) > limit)
      throw problem(serverMessages.releases.downloadLimit, 413);
    if (!response.body) return;
    reader = response.body.getReader();
    for (;;) {
      const { done, value } = await idle(reader.read());
      if (done) break;
      arm();
      state.length += value.length;
      if (state.length > limit) throw problem(serverMessages.releases.downloadLimit, 413);
      state.chunks.push(Buffer.from(value));
    }
  } catch (error) {
    throw controller.signal.aborted ? controller.signal.reason : error;
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort();
    reader?.cancel().catch(() => {});
  }
}
