import { randomBytes } from "node:crypto";
import {
  adapterCapabilitiesFor,
  libraryProtocol,
  routeBaseUrl,
} from "./endpoint-routing.js";

export const ADAPTER_URL_PLACEHOLDER = "__AGENTPIER_ADAPTER_URL__";
const CLIENT_PROTOCOL = Object.freeze({ claude: "messages", codex: "responses" });

export const createSessionToken = () => randomBytes(32).toString("base64url");

export function withLoopbackNoProxy(env) {
  for (const name of ["NO_PROXY", "no_proxy"]) {
    const hosts = (env[name] || "")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean);
    for (const host of ["127.0.0.1", "localhost"])
      if (!hosts.includes(host)) hosts.push(host);
    env[name] = hosts.join(",");
  }
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
