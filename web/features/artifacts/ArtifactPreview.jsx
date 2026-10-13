import React, { useEffect, useRef, useState } from "react";
import api from "../../lib/api.js";
import { artifactCopy as copy } from "../../lib/i18n/messages/artifacts.js";
import { artifactPreviewDocument } from "./artifact-preview.js";

// Waits until the preview area is on screen: the bundle is a full download and the
// server serves two at a time.
function useVisible(ref) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || visible) return undefined;
    if (typeof IntersectionObserver !== "function") {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, visible]);
  return visible;
}

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

async function loadPreview(id, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      const snapshot = await api(
        `/artifacts/${encodeURIComponent(id)}/bundle`,
        "GET",
        undefined,
        signal,
      );
      return await artifactPreviewDocument(snapshot);
    } catch (failure) {
      if (failure?.code !== "ARTIFACT_BUSY" || attempt >= busyDelays.length)
        throw failure;
      await wait(busyDelays[attempt], signal);
    }
  }
}

/** A scaled, inert picture of the selected artifact; loaded once per version. */
export default function ArtifactPreview({ item }) {
  const frame = useRef(null);
  const visible = useVisible(frame);
  const version = `${item.id}:${item.updatedAt}`;
  const [state, setState] = useState(null);
  useEffect(() => {
    if (!visible) return undefined;
    const controller = new AbortController();
    setState(null);
    loadPreview(item.id, controller.signal)
      .then((html) => {
        if (!controller.signal.aborted) setState({ version, html });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ version, failed: true });
      });
    return () => controller.abort();
    // The version changes when the artifact is replaced; polling alone never reloads.
  }, [visible, version, item.id]);
  const current = state?.version === version ? state : null;
  // `inert`: neither pointer nor keyboard reaches links inside the picture.
  return (
    <div className="artifact-preview" ref={frame}>
      {current?.html ? (
        <iframe
          title={copy.previewLabel(item.title)}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={current.html}
          tabIndex={-1}
          inert
          loading="lazy"
        />
      ) : (
        <p className="artifact-preview-note" role="status">
          {current?.failed ? copy.previewUnavailable : copy.previewLoading}
        </p>
      )}
    </div>
  );
}
