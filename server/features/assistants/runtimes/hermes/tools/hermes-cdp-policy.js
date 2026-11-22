// What Hermes's browser_cdp may send to a Hermes agent's own Chromium
// (AGENTPIER-480). browser_cdp passes any CDP command through (Hermes v0.23.3
// tools/browser_cdp_tool.py), and an agent without a shell browses with it alone, so
// the team plugin's guard (hermes-tool-guard.js) refuses what reaches past the web
// pages it works on: a file field filled from a host path (uploads go through
// agentpier_browser_upload and the files AgentPier staged), a download folder, the
// browser's own settings and windows (`Browser.*` beyond its version), a resource the
// browser loads into DevTools (Network.loadNetworkResource reads `file:` too), a
// DevTools channel handed to a page or a browser session, certificate errors switched
// off for the whole browser, and navigation to anything but a web page or
// about:blank (`file:`, `chrome:`, `devtools:`, `view-source:`, `javascript:`).
// AgentPier's navigation guard on the browser (hermes-browser-guard.js) refuses
// non-web documents as well; this keeps them from being asked for at all.

export const cdpRefusals = Object.freeze({
  method:
    "This browser command is not available to you: it reaches outside the web pages you work on.",
  upload:
    "Set files only with agentpier_browser_upload: call agentpier_workspace with action browser_upload_stage first and pass the uploadPath it returns.",
  address: "Open only web pages (http or https) or about:blank in your browser.",
});

const refusedMethods = new Set([
  "page.setdownloadbehavior",
  "network.loadnetworkresource",
  "target.exposedevtoolsprotocol",
  "target.attachtobrowsertarget",
  "security.setignorecertificateerrors",
]);
// The methods that name an address the browser opens: their parameter.
const navigations = { "page.navigate": "url", "target.createtarget": "url" };

/** Whether `url` is a web page or about:blank. */
export function webAddress(url) {
  if (typeof url !== "string") return false;
  const value = url.trim();
  if (value.toLowerCase() === "about:blank") return true;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * The refusal of a browser_cdp call (`{ method, params }`, its arguments), or null.
 * Method names are matched without regard to case.
 */
export function cdpRefusal(args) {
  if (typeof args?.method !== "string" || !args.method.trim()) return cdpRefusals.method;
  const method = args.method.trim().toLowerCase();
  if (method === "dom.setfileinputfiles") return cdpRefusals.upload;
  if (method.startsWith("browser.") && method !== "browser.getversion")
    return cdpRefusals.method;
  if (refusedMethods.has(method)) return cdpRefusals.method;
  const field = navigations[method];
  if (field && !webAddress(args.params?.[field])) return cdpRefusals.address;
  return null;
}
