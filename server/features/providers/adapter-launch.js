import { randomBytes } from "node:crypto";
import {
  adapterCapabilitiesFor,
  libraryProtocol,
  routeBaseUrl,
} from "./endpoint-routing.js";

/**
 * Substitution contract: once the adapter is bound, the launcher replaces every occurrence
 * of this placeholder as a SUBSTRING (CLI env values such as `ANTHROPIC_BASE_URL`, and argv
 * elements such as the Codex `-c model_providers=…` inline table that appends `/v1`) with
 * the origin `http://127.0.0.1:<port>`, without trailing slash and without path. Only env
 * values and argv are rewritten, never the initial input or any persisted file.
 */
export const ADAPTER_URL_PLACEHOLDER = "__AGENTPIER_ADAPTER_URL__";
/**
 * The adapter's bare port (digits only), substituted by the same launcher step. The nono
 * wrapper puts it behind `--open-port`, composed by the server before the port exists.
 */
export const ADAPTER_PORT_PLACEHOLDER = "__AGENTPIER_ADAPTER_PORT__";
const CLIENT_PROTOCOL = Object.freeze({ claude: "messages", codex: "responses" });

export const createSessionToken = () => randomBytes(32).toString("base64url");

/** Tools read either spelling first, so both get one merged, deduplicated list. */
export function withLoopbackNoProxy(env) {
  const hosts = new Set();
  for (const name of ["NO_PROXY", "no_proxy"])
    for (const host of (env[name] || "").split(","))
      if (host.trim()) hosts.add(host.trim());
  for (const host of ["127.0.0.1", "localhost"]) hosts.add(host);
  env.NO_PROXY = env.no_proxy = [...hosts].join(",");
}

export function adapterBlock({ tool, description, endpoint, secret, token }) {
  const { route, model, auth } = description;
  return {
    token,
    clientProtocol: CLIENT_PROTOCOL[tool],
    upstreamProtocol: libraryProtocol(route.source),
    upstream: {
      baseUrl: routeBaseUrl(endpoint, route),
      authHeader: auth.header || null,
      apiKey: secret?.apiKey?.trim() || null,
    },
    model: {
      modelId: model.modelId,
      contextTokens: model.contextTokens,
      outputTokens: model.outputTokens,
      images: model.images ?? null,
    },
    capabilities: adapterCapabilitiesFor(endpoint, route.source),
    thinkTagExtraction: endpoint.thinkTagExtraction === true,
  };
}
