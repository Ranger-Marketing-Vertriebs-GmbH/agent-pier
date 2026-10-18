import { observeBuild } from "./build-check.js";
import { downloadName } from "./download-name.js";

// Files up to this size are fetched and handed to the share sheet; a larger or
// unsized one opens outside the app instead of being held in memory.
export const MAX_SAVE_BUFFER = 50 * 1024 * 1024;
// A share sheet the browser refused for want of a fresh tap: SavePrompt asks again.
export const SAVE_PENDING_EVENT = "agentpier-save-pending";

const touchApple = (navigator) =>
  /iPhone|iPad|iPod/.test(String(navigator?.platform || "")) ||
  (navigator?.platform === "MacIntel" && navigator?.maxTouchPoints > 1);

/**
 * Whether AgentPier runs as a home-screen app on an iPhone or iPad. There iOS shows
 * no browser chrome: a link that navigates to a file leaves the app with no way
 * back, and `download` is ignored for media, so files go through the share sheet.
 * Installed apps elsewhere (desktop, Android) download files like a browser tab.
 */
export function appleStandalone() {
  try {
    const navigator = globalThis.navigator;
    if (navigator?.standalone === true) return true;
    return (
      globalThis.matchMedia?.("(display-mode: standalone)")?.matches === true &&
      touchApple(navigator)
    );
  } catch {
    return false;
  }
}

/**
 * Opens the share sheet for `file`. Safari refuses it (NotAllowedError) once the
 * tap that started a download is spent on fetching it: then SavePrompt offers one
 * more tap. Resolves to "shared", "cancelled" or "tap".
 */
export async function shareFile(file) {
  try {
    await navigator.share({ files: [file] });
    return "shared";
  } catch (error) {
    if (error?.name === "AbortError") return "cancelled";
    if (error?.name === "NotAllowedError") {
      window.dispatchEvent(new CustomEvent(SAVE_PENDING_EVENT, { detail: { file } }));
      return "tap";
    }
    throw error;
  }
}

/**
 * Saves a file without navigating an iPhone or iPad home-screen app: there through
 * the share sheet (Save to Files, AirDrop, open in another app) or, without file
 * sharing, a separate window; elsewhere through a download link.
 */
export async function saveBlob(blob, name, { fallbackUrl = null } = {}) {
  if (appleStandalone()) {
    const file = new File([blob], name, {
      type: blob.type || "application/octet-stream",
    });
    if (globalThis.navigator?.canShare?.({ files: [file] })) return shareFile(file);
    // A separate window keeps the app where it was.
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

const failed = (response) =>
  Object.assign(Error(String(response.status)), { status: response.status });

/**
 * Saves a same-origin file in a home-screen app (FileLink): its size first, so a
 * large or unsized one (a backup, an archive) opens outside the app instead of
 * filling memory; a small one goes to the share sheet by `name` or its own.
 */
export async function saveUrl(url, name) {
  const head = observeBuild(
    await fetch(url, { method: "HEAD", credentials: "same-origin" }),
  );
  if (!head.ok) throw failed(head);
  const size = Number(head.headers.get("content-length"));
  if (!Number.isFinite(size) || size <= 0 || size > MAX_SAVE_BUFFER) {
    window.open(url, "_blank", "noopener");
    return "opened";
  }
  const response = observeBuild(await fetch(url, { credentials: "same-origin" }));
  if (!response.ok) throw failed(response);
  const saved = name || downloadName(response.headers.get("Content-Disposition"));
  return saveBlob(await response.blob(), saved, { fallbackUrl: url });
}
