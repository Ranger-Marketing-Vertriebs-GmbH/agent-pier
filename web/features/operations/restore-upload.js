import api, { apiError } from "../../lib/api.js";
import { observeBuild } from "../../lib/build-check.js";

// Slices stay far below the server's request timeout even on slow links.
const SLICE = 16 * 1024 * 1024;
const ATTEMPTS = 4;
// Network failures, an offset the server did not expect and server errors are
// retried from the server's offset; anything else (no space, invalid) is final.
const retryable = (error) =>
  error?.status === undefined || error.status === 409 || error.status >= 500;
// A slice the server is still taking (409) gets time to finish before the retry.
const pause = (failures) => new Promise((resolve) => setTimeout(resolve, 250 * failures));

/**
 * Uploads `file` for a restore in slices. `uploadId` continues an earlier upload of
 * the same file where the server's copy ends; one the server no longer has (expired
 * or completed) is started again. Calls `started(uploadId)` once and
 * `progress(done, total)` after each slice; returns the archive id.
 */
export async function uploadArchive(file, { uploadId, started, progress }) {
  let state = uploadId
    ? await api(`/operations/restore/uploads/${uploadId}`).catch((error) => {
        if (error?.status === 404) return null;
        throw error;
      })
    : null;
  state ||= await api("/operations/restore/uploads", "POST", { size: file.size });
  if (state.size !== file.size) throw new Error("upload size mismatch");
  started?.(state.uploadId);
  const slice = Math.min(SLICE, state.chunkLimit);
  let failures = 0;
  while (state.offset < file.size) {
    progress?.(state.offset, file.size);
    const end = Math.min(file.size, state.offset + slice);
    try {
      const response = observeBuild(
        await fetch(
          `/api/operations/restore/uploads/${state.uploadId}?offset=${state.offset}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/octet-stream" },
            body: file.slice(state.offset, end),
          },
        ),
      );
      if (!response.ok) throw await apiError(response);
      state = await response.json();
      failures = 0;
    } catch (error) {
      if (!retryable(error) || ++failures >= ATTEMPTS) throw error;
      if (error.status === 409) await pause(failures);
      state = await api(`/operations/restore/uploads/${state.uploadId}`);
    }
  }
  progress?.(file.size, file.size);
  const result = await api(
    `/operations/restore/uploads/${state.uploadId}/complete`,
    "POST",
    {},
  );
  return result.archiveId;
}
