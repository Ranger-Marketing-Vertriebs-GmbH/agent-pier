import React from "react";
import { commandSegments } from "./ssh-command-text.js";

/** A command exactly as it runs; hidden characters appear as code badges. */
export default function SshCommandText({ command }) {
  return commandSegments(command).map((s, i) =>
    "hidden" in s ? (
      <span key={i} className="ssh-hidden-char" title={s.code}>
        {s.code}
      </span>
    ) : (
      <React.Fragment key={i}>{s.text}</React.Fragment>
    ),
  );
}
