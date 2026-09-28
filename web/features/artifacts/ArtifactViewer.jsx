import React, { useRef } from "react";
import useLanguage from "../../lib/i18n/useLanguage.js";
import { artifactCopy as copy } from "../../lib/i18n/messages/artifacts.js";
import useArtifactDocument from "./useArtifactDocument.js";
import { artifactReturnPath } from "./artifact-return-link.js";
import "./artifacts.css";
export default function ArtifactViewer({ id }) {
  useLanguage();
  const frame = useRef(null);
  const { current, title, linkError, canGoBack, goBack } = useArtifactDocument(id, frame);
  return (
    <main className="artifact-viewer">
      <header className="artifact-viewer-header">
        <h1 title={title || copy.viewer}>{title || copy.viewer}</h1>
        <a
          className="button secondary artifact-viewer-return"
          href={artifactReturnPath(window.location.search)}
        >
          {copy.backToApp}
        </a>
      </header>
      {canGoBack && (
        <button className="button secondary artifact-viewer-back" onClick={goBack}>
          {copy.previousPage}
        </button>
      )}
      {linkError && <p role="alert">{copy.linkUnavailable}</p>}
      {!current ? (
        <p role="status">{copy.loading}</p>
      ) : current.error ? (
        <p role="alert">{copy[current.error]}</p>
      ) : (
        <iframe
          ref={frame}
          title={copy.viewer}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={current.html}
        />
      )}
    </main>
  );
}
