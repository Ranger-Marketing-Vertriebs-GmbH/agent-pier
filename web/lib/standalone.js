import { observeBuild } from "./build-check.js";

/**
 * Whether AgentPier runs as an installed home-screen app. There, iOS has no browser
 * chrome: a link that navigates to a file (a download, a PDF, a video) leaves the
 * app with no way back, and `download` is ignored for media. Files are then handed
 * over through the share sheet instead (saveBlob).
 */
export function isStandalone() {
  try {
    return (
      globalThis.matchMedia?.("(display-mode: standalone)")?.matches === true ||
      globalThis.navigator?.standalone === true
    );
  } catch {
    return false;
  }
}

/**
 * Saves a file without ever navigating a standalone app: there through the share
 * sheet (Save to Files, AirDrop, open in another app) or, without file sharing, a
 * separate browser window; elsewhere through a download link. Resolves to "shared",
 * "opened", "cancelled" or "downloaded".
 */
export async function saveBlob(blob, name, { fallbackUrl = null } = {}) {
  if (isStandalone()) {
    const file = new File([blob], name, {
      type: blob.type || "application/octet-stream",
    });
    if (globalThis.navigator?.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return "shared";
      } catch (error) {
        if (error?.name === "AbortError") return "cancelled";
        throw error;
      }
    }
    // A separate window keeps the app where it was; it closes on its own.
    const url = fallbackUrl || URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
    if (!fallbackUrl) setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return "opened";
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Safari reads the blob after the click returns; keep it a little while.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "downloaded";
}

/** The file name a Content-Disposition header names, or `fallback`. */
export function dispositionName(header, fallback = "download") {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header || "")?.[1];
  if (encoded)
    try {
      return decodeURIComponent(encoded);
    } catch {
      /* A malformed name falls back to the plain one. */
    }
  return /filename="?([^";]+)"?/i.exec(header || "")?.[1] || fallback;
}

/** Fetches a same-origin file and saves it like saveBlob, by `name` or its own. */
export async function saveUrl(url, name) {
  const response = observeBuild(await fetch(url, { credentials: "same-origin" }));
  if (!response.ok) throw Error(String(response.status));
  const saved = name || dispositionName(response.headers.get("Content-Disposition"));
  return saveBlob(await response.blob(), saved, { fallbackUrl: url });
}
