import { isLiveStubRequest } from "./live-stub.js";

// Pretends the tab is hidden or visible: both flags change, then the event fires.
export async function setTabHidden(page, hidden) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (value ? "hidden" : "visible"),
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

// Records every request the page sends to /api/, in order, as { method, path }; the
// live stub's own REST reads are not the page's and are skipped.
export function recordApiRequests(page) {
  let requests = [];
  page.on("request", (request) => {
    if (isLiveStubRequest(request)) return;
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/"))
      requests.push({ method: request.method(), path: url.pathname });
  });
  return {
    list: () => [...requests],
    clear: () => {
      requests = [];
    },
  };
}
