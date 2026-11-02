// Fills a file field of a page in a Hermes agent's AgentPier-owned Chromium
// (hermes-browser.js). Hermes v0.22.5's browser tools offer no upload
// (tools/browser_tool.py), so AgentPier sets the files itself over CDP
// (`DOM.setFileInputFiles`) on the page the agent works in. The files are ones
// AgentPier staged for the agent (browser-upload-staging.js), admitted before this
// runs (hermes-browser-upload.js).

const problem = (code) => Object.assign(Error(code), { code });
const timeoutMs = 10000;

/**
 * The page tab to fill among `tabs` (HermesBrowser.tabs): the one `targetId` names,
 * else the only page whose address contains `urlContains`, else the only page.
 */
export function uploadTab(tabs, { targetId, urlContains } = {}) {
  const pages = tabs.filter((tab) => tab.type === "page" && tab.socket);
  if (targetId) {
    const tab = pages.find((page) => page.targetId === targetId);
    if (!tab) throw problem("BROWSER_NO_TAB");
    return tab;
  }
  const matching = urlContains
    ? pages.filter((page) => page.url.includes(urlContains))
    : pages;
  if (!matching.length) throw problem("BROWSER_NO_TAB");
  if (matching.length > 1) throw problem("BROWSER_TAB_AMBIGUOUS");
  return matching[0];
}

/**
 * Sets `files` (absolute paths) on the first element `selector` names in `tab`'s
 * page: `{ url }` of the page, or a refusal: BROWSER_NO_ELEMENT, BROWSER_NOT_FILE_INPUT
 * (CDP refuses any other element), BROWSER_CDP_FAILED.
 */
export function setFileInputFiles(tab, { selector, files }, WebSocketImpl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(tab.socket);
    const waiting = new Map();
    let id = 0;
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
    const call = (method, params = {}) =>
      new Promise((done, fail) => {
        waiting.set(++id, { done, fail });
        ws.send(JSON.stringify({ id, method, params }));
      });
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
      const pending = waiting.get(message.id);
      if (!pending) return;
      waiting.delete(message.id);
      if (message.error) pending.fail(Object.assign(problem("CDP"), message.error));
      else pending.done(message.result || {});
    };
    ws.onerror = () => finish(problem("BROWSER_CDP_FAILED"));
    ws.onopen = async () => {
      try {
        const { root } = await call("DOM.getDocument", { depth: 0 });
        const { nodeId } = await call("DOM.querySelector", {
          nodeId: root.nodeId,
          selector,
        });
        if (!nodeId) return finish(problem("BROWSER_NO_ELEMENT"));
        await call("DOM.setFileInputFiles", { nodeId, files }).catch(() => {
          throw problem("BROWSER_NOT_FILE_INPUT");
        });
        finish(null, { url: tab.url });
      } catch (error) {
        finish(
          error?.code?.startsWith?.("BROWSER_") ? error : problem("BROWSER_CDP_FAILED"),
        );
      }
    };
  });
}
