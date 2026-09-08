import "@xterm/xterm/css/xterm.css";
import { commonCopy } from "../../lib/i18n/de/common.js";

import ErrorMessage from "../../components/ErrorMessage.jsx";
import React from "react";

import useTerminalConnection from "./useTerminalConnection.js";
export default function TerminalView({
  session,
  mode,
  sendRef,
  focusRef,
  onConnection,
  request,
}) {
  const { error, container } = useTerminalConnection({
    session,
    mode,
    sendRef,
    focusRef,
    onConnection,
    request,
  });
  return (
    <div className={`terminal-pane ${mode !== "terminal" ? "hidden" : ""}`}>
      <ErrorMessage error={error} />
      <div
        className="terminal-mount"
        ref={container}
        aria-label={commonCopy.interactiveTerminal}
      />
    </div>
  );
}
