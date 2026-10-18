import { apiError } from "../../lib/api.js";
import { saveBlob } from "../../lib/standalone.js";
import { downloadName } from "../../lib/download-name.js";
import { observeBuild } from "../../lib/build-check.js";

// One Content-Disposition parser for every download (lib/download-name.js).
export { downloadName };

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
