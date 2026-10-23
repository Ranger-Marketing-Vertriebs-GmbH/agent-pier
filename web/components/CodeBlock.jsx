import React, { useRef } from "react";
import Icon from "./Icon.jsx";
import useCopy from "./useCopy.js";
import { chatMessageCopy as copy } from "../lib/i18n/messages/chat.js";
import "./code-block.css";

// Selects the block so the reader can copy it by hand where the Clipboard API is
// missing (plain HTTP) or refuses the write (for example iOS outside a user gesture).
function selectContents(element) {
  const selection = window.getSelection(),
    range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

// A fenced Markdown code block with a copy button. The button sits outside the
// scrolling <pre>, so long lines keep their horizontal scroll and the copied text is
// exactly the code without the fence's trailing newline. `copyText` copies a given
// text instead and `copyLabel` names the button (ActivityRow bodies).
export default function CodeBlock({
  node: _node,
  className,
  children,
  copyText: text,
  copyLabel = copy.copyCode,
  ...props
}) {
  const pre = useRef(null),
    { status, copy: copyText } = useCopy();
  const copyCode = async () => {
    const element = pre.current;
    if (!(await copyText(text ?? element.textContent.replace(/\n$/, ""))))
      selectContents(element);
  };
  return (
    <div className="code-block">
      <pre
        ref={pre}
        {...props}
        className={className ? `code-block-pre ${className}` : "code-block-pre"}
      >
        {children}
      </pre>
      <button
        type="button"
        className="code-block-copy"
        aria-label={copyLabel}
        title={copyLabel}
        data-copied={status === "copied" || undefined}
        onClick={copyCode}
      >
        <Icon name={status === "copied" ? "check" : "copy"} size={16} />
      </button>
      <span
        role="status"
        className={
          status === "failed" ? "code-block-status" : "code-block-status visually-hidden"
        }
      >
        {status === "copied"
          ? copy.codeCopied
          : status === "failed"
            ? copy.codeCopyFailed
            : ""}
      </span>
    </div>
  );
}
