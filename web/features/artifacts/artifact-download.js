import { apiError } from "../../lib/api.js";
import { saveBlob } from "../../lib/standalone.js";
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
  // A standalone app gets the share sheet instead of a navigation (lib/standalone.js).
  await saveBlob(await response.blob(), name);
  return name;
}
