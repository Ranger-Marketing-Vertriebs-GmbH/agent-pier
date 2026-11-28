import React, { useEffect, useRef, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import FileLink from "../../components/FileLink.jsx";
import Icon from "../../components/Icon.jsx";
import SidePanel from "../../components/SidePanel.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { assistantAttachmentsCopy as copy } from "../../lib/i18n/messages/assistant-attachments.js";
import { canvasScale } from "./agent-pdf-preview.js";
import usePdfDocument from "./usePdfDocument.js";
import "./agent-attachments.css";

const ZOOM_STEP = 1.25;

// One page: a placeholder of its size, drawn on its canvas while it is within one
// panel height of the panel's visible area, and released when it scrolls further away. The backing store follows the
// screen's pixel ratio but stays under MAX_CANVAS_PIXELS (iOS blanks larger canvases);
// the CSS size stays the zoomed size.
function PdfPage({ document, number, count, scale, fallback }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  const [size, setSize] = useState(null);
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      // The scrolling panel body is the root: the margin grows its visible area. The
      // pinboard reader has none and scrolls with its area.
      { root: ref.current.closest(".side-panel-body"), rootMargin: "100% 0px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const canvas = ref.current;
    if (!visible) {
      canvas.width = 0;
      canvas.height = 0;
      return undefined;
    }
    let live = true;
    let task = null;
    (async () => {
      try {
        const page = await document.getPage(number);
        if (!live) return;
        const base = page.getViewport({ scale: 1 });
        setSize((old) =>
          old?.width === base.width && old?.height === base.height
            ? old
            : { width: base.width, height: base.height },
        );
        const ratio = window.devicePixelRatio || 1;
        const viewport = page.getViewport({
          scale: canvasScale(base.width, base.height, scale, ratio),
        });
        // Floored: rounding up could pass the pixel cap.
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        task = page.render({ canvas, viewport });
        await task.promise;
      } catch {
        // Cancelled, or the document closed with the panel.
      }
    })();
    return () => {
      live = false;
      task?.cancel();
    };
  }, [document, number, scale, visible]);
  const { width, height } = size || fallback;
  return (
    <canvas
      ref={ref}
      className="agent-pdf-page"
      role="img"
      aria-label={copy.pdfPage(number, count)}
      width={0}
      height={0}
      style={{ width: `${width * scale}px`, height: `${height * scale}px` }}
    />
  );
}

// A zoom button that cannot act right now stays focusable (aria-disabled) and ignores
// the click, so focus never drops out of the panel when Fit width or a zoom limit is
// reached.
function ZoomButton({ label, icon, off, onClick }) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      aria-disabled={off || undefined}
      onClick={off ? undefined : onClick}
    >
      <Icon name={icon} />
    </button>
  );
}

// The pages under a toolbar: Fit width (the scale at which the first page fills the
// panel's width, kept as the panel resizes) and Zoom in / Zoom out in steps of x1.25,
// from half to four times that width.
export function PdfPages({ document }) {
  const count = document.numPages;
  const list = useRef(null);
  const [first, setFirst] = useState(null);
  const [room, setRoom] = useState(0);
  const [zoom, setZoom] = useState(null);
  useEffect(() => {
    let live = true;
    document
      .getPage(1)
      .then((page) => {
        const { width, height } = page.getViewport({ scale: 1 });
        if (live) setFirst({ width, height });
      })
      .catch(() => live && setFirst({ failed: true }));
    return () => {
      live = false;
    };
  }, [document]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setRoom(Math.floor(entry.contentRect.width)),
    );
    observer.observe(list.current);
    return () => observer.disconnect();
  }, []);
  const fit = first?.width && room ? room / first.width : 0;
  const scale = zoom ?? fit;
  const min = fit * 0.5;
  const max = fit * 4;
  const step = (factor) => setZoom(Math.min(max, Math.max(min, scale * factor)));
  // A first page that cannot be read fails the preview, never an empty panel.
  if (first?.failed) return <ErrorMessage error={copy.previewFailed} />;
  return (
    <>
      <div className="agent-pdf-toolbar">
        <span className="agent-pdf-count">{copy.pdfPages(count)}</span>
        <div className="agent-pdf-zoom">
          <ZoomButton
            label={copy.zoomOut}
            icon="zoom-out"
            off={!fit || scale <= min}
            onClick={() => step(1 / ZOOM_STEP)}
          />
          <ZoomButton
            label={copy.zoomFit}
            icon="fit-width"
            off={!fit || zoom === null}
            onClick={() => setZoom(null)}
          />
          <ZoomButton
            label={copy.zoomIn}
            icon="zoom-in"
            off={!fit || scale >= max}
            onClick={() => step(ZOOM_STEP)}
          />
        </div>
      </div>
      <div className="agent-pdf-pages" ref={list}>
        {fit > 0 &&
          Array.from({ length: count }, (_, index) => (
            <PdfPage
              key={index + 1}
              document={document}
              number={index + 1}
              count={count}
              scale={scale}
              fallback={first}
            />
          ))}
      </div>
    </>
  );
}

/**
 * A PDF from the agent chat in a side panel (a bottom sheet on phones), every page
 * drawn by pdf.js on a canvas as it scrolls in; scripts in the file never run. The
 * bytes come from the same signed-in route as the download, without `download=1`,
 * read up to the preview cap; a larger file, or one pdf.js cannot open (broken,
 * password-protected), says so and keeps the download. Escape, the close buttons
 * and a click beside the panel close it, and focus returns to the opener.
 */
export default function AgentPdfPreview({ file, src, details, limit, opener, close }) {
  const state = usePdfDocument(src, file);
  return (
    <SidePanel
      title={file.name}
      subtitle={details}
      close={close}
      opener={opener}
      cancelLabel={commonCopy.close}
      footer={
        <FileLink
          className="button primary"
          href={`${src}?download=1`}
          name={file.name}
          aria-label={copy.download(file.name)}
        >
          {copy.previewDownload}
        </FileLink>
      }
    >
      {state.loading ? (
        <p className="loading" role="status">
          {copy.previewLoading}
        </p>
      ) : state.failed ? (
        <ErrorMessage error={copy.previewFailed} />
      ) : state.tooLarge ? (
        <p className="agent-markdown-notice" role="status">
          {copy.previewTooLarge(limit)}
        </p>
      ) : (
        <PdfPages document={state.document} />
      )}
    </SidePanel>
  );
}
