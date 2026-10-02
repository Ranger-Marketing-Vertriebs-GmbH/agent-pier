import React, { useEffect, useState } from "react";
import useLanguage from "../../lib/i18n/useLanguage.js";
import { updateNoticeCopy as copy } from "../../lib/i18n/messages/app.js";
import { UPDATE_EVENT, updateDetected } from "../../lib/build-check.js";
import "./update-notice.css";

export default function UpdateNotice() {
  useLanguage();
  const [visible, setVisible] = useState(updateDetected);
  useEffect(() => {
    const show = () => setVisible(true);
    window.addEventListener(UPDATE_EVENT, show);
    if (updateDetected()) setVisible(true);
    return () => window.removeEventListener(UPDATE_EVENT, show);
  }, []);
  if (!visible) return null;
  return (
    <div className="update-notice" role="status">
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
