import React, { useEffect, useRef, useState } from "react";
import { directoryPickerCopy as copy } from "../../lib/i18n/messages/directories.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";

export default function CreateDirectory({ create, created, disabled }) {
  const [open, setOpen] = useState(false),
    [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    form = useRef(null);
  // The picker's footer is sticky: the form and its error scroll clear of it (phones).
  useEffect(() => {
    if (open) form.current?.scrollIntoView?.({ block: "nearest" });
  }, [open, error]);
  async function submit() {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await create(name.trim());
      setName("");
      setOpen(false);
      created(result.path);
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="create-directory" ref={form}>
      {!open ? (
        <button
          type="button"
          className="button secondary compact"
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          {copy.createDirectory}
        </button>
      ) : (
        <>
          <label>
            {copy.newDirectoryName}
            <input
              aria-label={copy.newDirectoryName}
              value={name}
              maxLength={255}
              disabled={busy}
              autoFocus
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          </label>
          <div className="create-directory-actions">
            <button
              type="button"
              className="button secondary compact"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setError("");
              }}
            >
              {copy.cancelCreate}
            </button>
            <button
              type="button"
              className="button primary compact"
              disabled={busy || !name.trim()}
              onClick={submit}
            >
              {copy.createDirectory}
            </button>
          </div>
        </>
      )}
      <ErrorMessage error={error} />
    </div>
  );
}
