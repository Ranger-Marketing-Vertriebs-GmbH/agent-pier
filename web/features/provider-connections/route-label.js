import { connectionCopy } from "../../lib/i18n/messages/connections.js";

export const protocolShortName = (source) =>
  connectionCopy.routes.shortNames[source] || source;

export function routeLabel(route) {
  const copy = connectionCopy.routes;
  if (!route) return copy.notOffered;
  if (route.mode === "native") return copy.native;
  if (route.mode === "adapter") return copy.adapter(protocolShortName(route.source));
  return protocolShortName(route.source);
}
