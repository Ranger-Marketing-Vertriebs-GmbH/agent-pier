import { Readable, pipeline } from "node:stream";
import { forwardHeaders, proxyError, readBody } from "./runtime-proxy.js";

// The ChatGPT part of the runtime proxy (runtime-proxy.js): `/chatgpt/codex/<path>`
// to the Codex backend `https://chatgpt.com/backend-api/codex/<path>` with the
// account's current access token. Hermes reaches a ChatGPT account this way
// (hermes-config/model.js: `provider: openai-codex`, HERMES_CODEX_BASE_URL); its
// requests carry no account identity of their own (Hermes v0.22.5
// agent/codex_headers.py drops ChatGPT-Account-ID for a non-JWT token), so the proxy
// adds `Authorization`, `ChatGPT-Account-Id` and the residency header
// `x-openai-internal-codex-residency`. Streams (SSE) pass through unbuffered.

export const codexUpstream = "https://chatgpt.com/backend-api";
// What Hermes calls: the Responses stream, its compaction and the model catalog;
// and, for image creation, the Codex images endpoints (Hermes v0.22.5
// plugins/image_gen/openai-codex: POST images/generations, images/edits).
const paths = /^codex\/(responses(\/compact)?|models)$/;
const imagePaths = /^codex\/images\/(generations|edits)$/;
// Never forwarded from the runtime: identity the proxy sets, cookies, and the
// response encodings it accepts (fetch negotiates and decodes its own).
const dropped = [
  "chatgpt-account-id",
  "x-openai-internal-codex-residency",
  "cookie",
  "accept-encoding",
];
// Response headers that describe the upstream hop or its encoding (fetch decodes).
const responseDropped = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  "www-authenticate",
]);

const loginCodes = new Set(["RELOGIN", "LOGIN_MISSING"]);

/**
 * The route handler. `authorize(agentId, profileId, { images, route })`: whether the
 * agent may still use the login (an agent removed since its credential was minted
 * may not), for its model or, with `images`, to create images; `route` is the Codex
 * path asked for ("codex/responses", …).
 */
export function chatgptRoute({
  vault,
  authorize = () => true,
  upstream = codexUpstream,
  fetch: fetchImpl = globalThis.fetch,
  warn = console.warn,
}) {
  return async (req, res, { scope, rest, search }) => {
    const [, agentId, profileId] = scope;
    const images = imagePaths.test(rest) && req.method === "POST";
    if (!images && (!paths.test(rest) || !["GET", "POST"].includes(req.method)))
      return proxyError(res, 404, "not_found", "Unknown ChatGPT route.");
    if (!profileId || !(await authorize(agentId, profileId, { images, route: rest })))
      return proxyError(
        res,
        403,
        "forbidden",
        "This agent may not use this ChatGPT login.",
      );
    let body;
    try {
      body = req.method === "POST" ? await readBody(req) : undefined;
    } catch (error) {
      return proxyError(
        res,
        error.status || 400,
        "invalid_request",
        "Unreadable request.",
      );
    }
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const send = async (stale) => {
      const credential = await vault.credential(profileId, { stale });
      const response = await fetchImpl(`${upstream}/${rest}${search || ""}`, {
        method: req.method,
        headers: {
          ...forwardHeaders(req.headers, dropped),
          authorization: `Bearer ${credential.access}`,
          ...(credential.accountId && { "chatgpt-account-id": credential.accountId }),
          ...(credential.residency && {
            "x-openai-internal-codex-residency": credential.residency,
          }),
        },
        body,
        signal: abort.signal,
        redirect: "manual",
      });
      return { response, credential };
    };
    let result;
    try {
      result = await send();
      // Once on a 401: the token may have been revoked or renewed elsewhere.
      if (result.response.status === 401) {
        await result.response.body?.cancel().catch(() => {});
        result = await send(result.credential.access);
      }
    } catch (error) {
      if (abort.signal.aborted) return res.destroy();
      if (loginCodes.has(error?.code))
        return proxyError(
          res,
          401,
          "agentpier_login_required",
          "The ChatGPT login needs a new sign-in in AgentPier.",
        );
      if (["REFRESH_FAILED", "NETWORK"].includes(error?.code))
        return proxyError(res, 503, "agentpier_refresh_failed", "Login renewal failed.", {
          "retry-after": "30",
        });
      warn(
        `The ChatGPT proxy could not reach the Codex backend (${error?.name || "error"}).`,
      );
      return proxyError(res, 502, "upstream_unreachable", "Codex backend unreachable.");
    }
    const { response } = result;
    const headers = {};
    response.headers.forEach((value, name) => {
      if (!responseDropped.has(name)) headers[name] = value;
    });
    res.writeHead(response.status, headers);
    res.flushHeaders();
    if (!response.body) return res.end();
    // Each chunk goes out as it arrives: SSE events reach the runtime at once. An error
    // on either side destroys both, and so ends the response and the upstream request.
    pipeline(Readable.fromWeb(response.body), res, (error) => error && abort.abort());
  };
}
