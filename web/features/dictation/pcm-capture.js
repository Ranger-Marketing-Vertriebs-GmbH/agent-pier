// Served from AgentPier itself: the CSP refuses an inlined data: worklet.
import workletUrl from "./pcm-capture-worklet.js?url&no-inline";

/** A stable reason for a refused or missing microphone. */
export const mediaError = (error) =>
  error?.name === "NotAllowedError" || error?.name === "SecurityError"
    ? "denied"
    : error?.name === "NotFoundError" || error?.name === "OverconstrainedError"
      ? "noMicrophone"
      : "failed";

/**
 * The microphone through the PCM worklet (pcm-capture-worklet.js) of `context`, for
 * dictation (useDictation.js) and talk mode (useTalk.js): each 100 ms frame of 16 kHz
 * PCM reaches `onFrame({ buffer, level })`. `context` must have been created in the
 * user's tap (Safari). `alive()` is asked after each wait: a capture nobody wants any
 * more is closed and null returned. Resolves to `{ media, node, close }`.
 */
export async function openPcmCapture(context, { onFrame, alive = () => true, resumed }) {
  const media = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  let node = null;
  const close = () => {
    media.getTracks().forEach((track) => track.stop());
    node?.port.close();
  };
  try {
    if (!alive()) return (close(), null);
    await resumed;
    // The worklet resamples whatever rate the device runs at (44.1 or 48 kHz).
    await context.audioWorklet.addModule(workletUrl);
    if (!alive()) return (close(), null);
    node = new AudioWorkletNode(context, "agentpier-pcm");
    const silent = context.createGain();
    silent.gain.value = 0;
    context.createMediaStreamSource(media).connect(node);
    node.connect(silent).connect(context.destination);
    node.port.onmessage = ({ data }) => onFrame(data);
  } catch (error) {
    close();
    throw error;
  }
  return { media, node, close };
}
