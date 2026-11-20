// The part of OpenClaw's browser control API the owner's browser toolbar uses
// (browser-live-view.js), for a Hermes agent's AgentPier-owned Chromium
// (hermes-browser.js): `POST /navigate` opens an address in a tab, `POST /tabs/focus`
// brings a tab to the front and `DELETE /tabs/<targetId>` closes one. The live view
// checks the owner's address against the agent browser's network rule before it
// calls; this adds the scheme check, as OpenClaw's route does, and keeps cloud
// metadata addresses blocked even with private networks allowed, as Hermes's own
// browser tools do (docs/hermes-runtime.md "Navigation policy").

const problem = (code) => Object.assign(Error(code), { code });
const timeoutMs = 10000;

const metadataHosts = new Set([
  "169.254.169.254",
  "[fd00:ec2::254]",
  "metadata.google.internal",
  "100.100.100.200",
]);
const webAddress = (value) => {
  try {
    const url = new URL(String(value));
    return url.href === "about:blank" ||
      (["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !metadataHosts.has(url.hostname.toLowerCase()))
      ? url.href
      : null;
  } catch {
    return null;
  }
};

/** One CDP call on `tab`'s own page socket: its result, or BROWSER_CDP_FAILED. */
export function pageCall(tab, method, params, WebSocketImpl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(tab.socket);
    const finish = (error, value) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* Closed already. */
      }
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(problem("BROWSER_CDP_FAILED")), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(
          typeof event.data === "string"
            ? event.data
            : Buffer.from(event.data).toString(),
        );
      } catch {
        return;
      }
      if (message.id !== 1) return;
      if (message.error || message.result?.errorText)
        finish(problem("BROWSER_NAVIGATION_FAILED"));
      else finish(null, message.result || {});
    };
    ws.onerror = () => finish(problem("BROWSER_CDP_FAILED"));
  });
}

/**
 * Answers a toolbar route for `browser` (a HermesBrowser), or undefined for any
 * other route. `tabs` are its page tabs with their loopback sockets.
 */
export async function toolbarRoute(browser, { method, route, body }) {
  // The tab `targetId` names; without one (an address only) the first page.
  const page = async (targetId, required = true) => {
    const tabs = (await browser.tabs()).filter((tab) => tab.type === "page");
    const tab =
      targetId || required ? tabs.find((one) => one.targetId === targetId) : tabs[0];
    if (!tab) throw problem("BROWSER_NO_TAB");
    return tab;
  };
  const devtools = async (action, targetId) => {
    const port = browser.knownPort();
    const response = await browser.fetch(
      `http://127.0.0.1:${port}/json/${action}/${encodeURIComponent(targetId)}`,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!response.ok) throw problem("BROWSER_NO_TAB");
  };
  if (method === "POST" && route === "/navigate") {
    const url = webAddress(body?.url);
    if (!url) throw problem("BROWSER_NAVIGATION_BLOCKED");
    const tab = await page(body?.targetId, false);
    if (!tab.socket) throw problem("BROWSER_NO_TAB");
    await pageCall(tab, "Page.navigate", { url }, browser.WebSocketImpl);
    return { ok: true, targetId: tab.targetId, url };
  }
  if (method === "POST" && route === "/tabs/focus") {
    const tab = await page(String(body?.targetId || ""));
    await devtools("activate", tab.targetId);
    return { ok: true, targetId: tab.targetId };
  }
  const closing = method === "DELETE" && /^\/tabs\/([^/]+)$/.exec(String(route || ""));
  if (closing) {
    const tab = await page(decodeURIComponent(closing[1]));
    await devtools("close", tab.targetId);
    return { ok: true, targetId: tab.targetId };
  }
  return undefined;
}
