import React from "react";
import { isStandalone, saveUrl } from "../lib/standalone.js";

/**
 * A same-origin download link that never navigates an installed home-screen app: in
 * a browser it is a plain link with `download`; in the standalone app a tap fetches
 * the file and hands it to the share sheet (lib/standalone.js). `name` is the file
 * name to save, or true for the server's own.
 */
export default function FileLink({ href, name = true, onError, children, ...props }) {
  return (
    <a
      {...props}
      href={href}
      download={name}
      onClick={(event) => {
        if (!isStandalone()) return;
        event.preventDefault();
        saveUrl(href, typeof name === "string" ? name : undefined).catch((error) =>
          onError?.(error),
        );
      }}
    >
      {children}
    </a>
  );
}
