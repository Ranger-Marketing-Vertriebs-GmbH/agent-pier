import React, { useEffect, useState } from "react";
import api from "../../lib/api.js";
import useLanguage from "../../lib/i18n/useLanguage.js";
import { artifactCopy as copy } from "../../lib/i18n/messages/artifacts.js";
import { prepareArtifactDocument } from "./artifact-document.js";
import "./artifacts.css";
export default function ArtifactViewer({ id }) {
  useLanguage();
  const [state, setState] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    api(
      `/artifacts/${encodeURIComponent(id)}/bundle`,
      "GET",
      undefined,
      controller.signal,
    )
      .then(async (snapshot) => ({
        title: snapshot.artifact.title,
        ...(await prepareArtifactDocument(snapshot)),
      }))
      .then((result) => {
        if (alive) setState({ id, ...result });
      })
      .catch((error) => {
        if (alive)
          setState({
            id,
            error:
              error.code === "ARTIFACT_RESOURCE_UNSUPPORTED"
                ? "unsupported"
                : "unavailable",
          });
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [id]);
  const current = state?.id === id ? state : null;
  return (
    <main className="artifact-viewer">
      <h1>{current?.title || copy.viewer}</h1>
      {!current ? (
        <p role="status">{copy.loading}</p>
      ) : current.error ? (
        <p role="alert">{copy[current.error]}</p>
      ) : (
        <iframe
          title={copy.viewer}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={current.html}
        />
      )}
    </main>
  );
}
