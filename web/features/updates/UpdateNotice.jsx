import React, { useEffect, useLayoutEffect, useState } from "react";
import useLanguage from "../../lib/i18n/useLanguage.js";
import { updateNoticeCopy as copy } from "../../lib/i18n/messages/app.js";
import { UPDATE_EVENT, updateDetected } from "../../lib/build-check.js";
import { noticeTop } from "./notice-placement.js";
import "./update-notice.css";

/**
 * Follows the page's own header while the notice shows: a page change, a resize or a
 * header that grows (tabs, a subtitle) moves the notice below it again.
 */
function useNoticeTop(visible) {
  const [top, setTop] = useState(null);
  useLayoutEffect(() => {
    if (!visible) return undefined;
    let frame = 0;
    const place = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setTop(noticeTop()));
    };
    setTop(noticeTop());
    const observer = new MutationObserver(place);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [visible]);
  return top;
}

export default function UpdateNotice() {
  useLanguage();
  const [visible, setVisible] = useState(updateDetected);
  useEffect(() => {
    const show = () => setVisible(true);
    window.addEventListener(UPDATE_EVENT, show);
    if (updateDetected()) setVisible(true);
    return () => window.removeEventListener(UPDATE_EVENT, show);
  }, []);
  const top = useNoticeTop(visible);
  if (!visible) return null;
  return (
    <div
      className="update-notice"
      role="status"
      style={top === null ? undefined : { top: `${top}px` }}
    >
      <span>{copy.message}</span>
      <button
        className="button primary"
        type="button"
        onClick={() => window.location.reload()}
      >
        {copy.reload}
      </button>
      <button
        className="update-notice-dismiss"
        type="button"
        aria-label={copy.dismiss}
        onClick={() => setVisible(false)}
      >
        ×
      </button>
    </div>
  );
}
