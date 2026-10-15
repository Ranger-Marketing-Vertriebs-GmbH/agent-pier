import React, { useEffect, useRef, useState } from "react";
import Icon from "./Icon.jsx";
import { chatMessageCopy as copy } from "../lib/i18n/messages/chat.js";
import "./code-block.css";

const copiedFor = 2000,
  failedFor = 6000;

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
// exactly the code without the fence's trailing newline.
export default function CodeBlock({ node: _node, className, children, ...props }) {
  const pre = useRef(null),
    timer = useRef(null),
    mounted = useRef(false),
    [status, setStatus] = useState("");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  // Clearing first and setting the status on the next tick lets the live region
  // announce a repeated copy again.
  const show = (next) => {
    clearTimeout(timer.current);
    setStatus("");
    timer.current = setTimeout(() => {
      setStatus(next);
      timer.current = setTimeout(
        () => setStatus(""),
        next === "copied" ? copiedFor : failedFor,
      );
    }, 50);
  };
  const copyCode = async () => {
    const element = pre.current;
    try {
      if (!navigator.clipboard?.writeText) throw Error("Clipboard unavailable");
      await navigator.clipboard.writeText(element.textContent.replace(/\n$/, ""));
      if (mounted.current) show("copied");
    } catch {
      // The write may settle after the message re-rendered without this block.
      if (!mounted.current) return;
      selectContents(element);
      show("failed");
    }
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
        aria-label={copy.copyCode}
        title={copy.copyCode}
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
