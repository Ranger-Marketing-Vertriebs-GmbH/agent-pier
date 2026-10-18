import React, { useState } from "react";
import { appleStandalone, saveUrl } from "../lib/standalone.js";
import { fileLinkCopy as copy } from "../lib/i18n/messages/components.js";
import "./file-link.css";

/**
 * A same-origin download link that never navigates an iPhone or iPad home-screen
 * app: elsewhere it is a plain link with `download`; in that app a tap fetches the
 * file and hands it to the share sheet (lib/standalone.js), busy until then and with
 * a visible error when it fails. `name` is the file name to save, or true for the
 * server's own.
 */
export default function FileLink({ href, name = true, children, ...props }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <>
      <a
        {...props}
        href={href}
        download={name}
        aria-busy={busy || undefined}
        onClick={async (event) => {
          if (!appleStandalone()) return;
          event.preventDefault();
          // A second tap while the first fetches would open two share sheets.
          if (busy) return;
          setBusy(true);
          setFailed(false);
          try {
            await saveUrl(href, typeof name === "string" ? name : undefined);
          } catch {
            setFailed(true);
          } finally {
            setBusy(false);
          }
        }}
      >
        {children}
      </a>
      {failed && (
        <span className="file-link-error" role="alert">
          {copy.failed}
        </span>
      )}
    </>
  );
}
