import React, { useRef } from "react";
import Icon from "../../components/Icon.jsx";
import AgentAttachmentTray from "../assistants/AgentAttachmentTray.jsx";
import { craftCopy } from "../../lib/i18n/messages/craft.js";

/**
 * Pictures of the original for a start or a follow-up (useCraftPictures): a hint, the
 * picked pictures as thumbnails with a remove button each, and a button that opens
 * the file picker (on a phone the photo library, the camera or Files).
 */
export default function CraftPictures({ pictures, hint, disabled = false }) {
  const copy = craftCopy.pictures;
  const picker = useRef(null);
  return (
    <div className="craft-pictures">
      {hint && <p className="craft-row-note">{hint}</p>}
      <AgentAttachmentTray attachments={pictures} label={copy.list} />
      <input
        ref={picker}
        type="file"
        accept="image/*"
        multiple
        hidden
        aria-label={copy.choose}
        onChange={(event) => {
          pictures.add(event.target.files);
          event.target.value = "";
        }}
      />
      <div className="craft-pictures-actions">
        <button
          type="button"
          className="button"
          disabled={disabled}
          onClick={() => picker.current?.click()}
        >
          <Icon name="plus" size={14} />
          {copy.add}
        </button>
      </div>
    </div>
  );
}
