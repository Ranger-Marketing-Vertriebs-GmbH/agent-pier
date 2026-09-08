import LanguageSelect from "../../components/LanguageSelect.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { settingsPageCopy as copy } from "../../lib/i18n/messages/settings.js";
import React, { useEffect, useRef, useState } from "react";
import api from "../../lib/api.js";
import Icon from "../../components/Icon.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Modal from "../../components/Modal.jsx";
import DirectoryPicker from "../directories/DirectoryPicker.jsx";
export default function DirectorySettings({ state, refresh }) {
  const serverCwd = state.defaultCwd || state.home || "";
  const editing = useRef(false);
  const [cwd, setCwd] = useState(serverCwd),
    [browse, setBrowse] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    setCwd((current) => (editing.current ? current : serverCwd));
  }, [serverCwd]);
  return (
    <div className="page settings-page">
      <div className="page-topline">
        <span>{copy.pageToplineLabel}</span>
      </div>
      <header className="page-heading">
        <div>
          <h1>{commonCopy.settings}</h1>
          <p>{copy.pageHeadingDescription}</p>
        </div>
      </header>
      <LanguageSelect />
      <form
        className="settings-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          setSaved(false);
          try {
            const result = await api("/preferences", "PATCH", {
              defaultCwd: cwd,
            });
            setCwd(result.defaultCwd);
            await refresh();
            editing.current = false;
            setSaved(true);
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          {copy.settingsFormFieldLabel}
          <div className="input-action">
            <input
              aria-label={copy.settingsFormFieldLabel}
              value={cwd}
              required
              disabled={busy}
              // Record edit intent without rendering between native focus and input.
              onFocus={() => {
                editing.current = true;
              }}
              onChange={(event) => {
                editing.current = true;
                setCwd(event.target.value);
                setSaved(false);
              }}
            />
            <button
              type="button"
              className="icon-button"
              aria-label={copy.iconButtonAriaLabel}
              disabled={busy}
              onClick={() => setBrowse(true)}
            >
              <Icon name="folder" />
            </button>
          </div>
        </label>
        <p className="field-description">{copy.defaultDirectoryDescription}</p>
        <ErrorMessage error={error} />
        {saved && (
          <p className="field-description" role="status">
            {copy.settingsSaved}
          </p>
        )}
        <div>
          <button className="button primary" disabled={busy || !cwd}>
            {busy ? commonCopy.saving : copy.saveSettings}
          </button>
        </div>
      </form>
      {browse && (
        <Modal title={copy.iconButtonAriaLabel} close={() => setBrowse(false)}>
          <DirectoryPicker
            initialPath={cwd || state.home}
            cancel={() => setBrowse(false)}
            choose={(path) => {
              editing.current = true;
              setCwd(path);
              setSaved(false);
              setBrowse(false);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
