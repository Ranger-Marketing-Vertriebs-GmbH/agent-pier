import "@xterm/xterm/css/xterm.css";
import { commonCopy } from "../../lib/i18n/messages/common.js";

import ErrorMessage from "../../components/ErrorMessage.jsx";
import React from "react";

import useFileDrop from "../../components/useFileDrop.js";
import useTerminalUploads from "./useTerminalUploads.js";
import TerminalUploads from "./TerminalUploads.jsx";
import { terminalViewCopy as copy } from "../../lib/i18n/messages/terminal.js";
import useTerminalConnection from "./useTerminalConnection.js";
export default function TerminalView({
  session,
  mode,
  sendRef,
  focusRef,
  onConnection,
  request,
}) {
  const { error, container, paste } = useTerminalConnection({
    session,
    mode,
    sendRef,
    focusRef,
    onConnection,
    request,
  });
  const uploads = useTerminalUploads({ session, paste });
  const drop = useFileDrop({
    enabled: mode === "terminal" && uploads.supported && !uploads.busy,
    onFiles: uploads.add,
  });
  return (
    <div
      className={`terminal-pane ${mode !== "terminal" ? "hidden" : ""}`}
      {...drop}
      data-drop-hint={copy.dropHint}
    >
      <ErrorMessage error={error} />
      <TerminalUploads uploads={uploads} paste={paste} />
      <div
        className="terminal-mount"
        ref={container}
        aria-label={commonCopy.interactiveTerminal}
      />
    </div>
  );
}
