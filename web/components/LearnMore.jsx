import React from "react";
import Icon from "./Icon.jsx";
import { commonCopy } from "../lib/i18n/messages/common.js";

// A short visible hint with the full explanation behind a "Learn more" disclosure, so
// dialogs open with their content instead of a wall of paragraphs.
export default function LearnMore({ hint, label, children }) {
  return (
    <div className="learn-more-hint">
      {hint && <p className="dialog-hint">{hint}</p>}
      <details className="learn-more">
        <summary>
          {label ?? commonCopy.learnMore}
          <Icon name="down" size={14} />
        </summary>
        <div className="learn-more-body">{children}</div>
      </details>
    </div>
  );
}
