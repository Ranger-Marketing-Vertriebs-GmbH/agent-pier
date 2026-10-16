import api from "../../lib/api.js";

// The server reads two bundles at a time and answers busy beyond that (another tab,
// Open, or a preview of an artifact selected a moment ago): wait and try again.
const busyDelays = [500, 1500, 3000];

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** An artifact's bundle; a busy server is retried a few times before failing. */
export async function loadArtifactBundle(id, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api(
        `/artifacts/${encodeURIComponent(id)}/bundle`,
        "GET",
        undefined,
        signal,
      );
    } catch (failure) {
      if (failure?.code !== "ARTIFACT_BUSY" || attempt >= busyDelays.length)
        throw failure;
      await wait(busyDelays[attempt], signal);
    }
  }
}
