import { apiError } from "../../lib/api.js";
import { observeBuild } from "../../lib/build-check.js";

/** The file name a download response names (RFC 5987 first), or `fallback`. */
export function downloadName(header, fallback) {
  const value = String(header || "");
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (encoded)
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      // A malformed name falls back to the plain one.
    }
  const plain = /filename="([^"]*)"/i.exec(value);
  return plain?.[1] || fallback;
}

/**
 * Saves the artifact through a blob link, so an installed home-screen app never
 * navigates away to the file, and a refused download surfaces as an error instead.
 */
export async function downloadArtifact(item) {
  const response = observeBuild(
    await fetch(`/api/artifacts/${encodeURIComponent(item.id)}/download`),
  );
  if (!response.ok) throw await apiError(response);
  const name = downloadName(response.headers.get("Content-Disposition"), "artifact");
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Safari reads the blob after the click returns; keep it a little while.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return name;
}
