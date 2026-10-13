import React, { useState } from "react";
import Icon from "../../components/Icon.jsx";
import ListRow from "../../components/ListRow.jsx";
import Modal from "../../components/Modal.jsx";
import DirectoryPicker from "../directories/DirectoryPicker.jsx";
import { settingsPageCopy as copy } from "../../lib/i18n/messages/settings.js";

// The default working directory: typed or chosen in the folder picker.
export default function DirectoryRow({ value, home, disabled, onChange }) {
  const [browse, setBrowse] = useState(false);
  return (
    <>
      <ListRow
        className="directory-row"
        label={copy.settingsFormFieldLabel}
        hint={copy.defaultDirectoryDescription}
      >
        <span className="directory-row-field">
          <input
            aria-label={copy.settingsFormFieldLabel}
            value={value}
            required
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
          <button
            type="button"
            className="icon-button"
            aria-label={copy.iconButtonAriaLabel}
            disabled={disabled}
            onClick={() => setBrowse(true)}
          >
            <Icon name="folder" />
          </button>
        </span>
      </ListRow>
      {browse && (
        <Modal title={copy.iconButtonAriaLabel} close={() => setBrowse(false)}>
          <DirectoryPicker
            initialPath={value || home}
            cancel={() => setBrowse(false)}
            choose={(path) => {
              onChange(path);
              setBrowse(false);
            }}
          />
        </Modal>
      )}
    </>
  );
}
