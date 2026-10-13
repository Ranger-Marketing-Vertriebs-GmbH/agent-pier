import React from "react";
import Icon from "../../../components/Icon.jsx";
import {
  InfoHintButton,
  InfoHintText,
  useInfoHint,
} from "../../../components/InfoHint.jsx";
import { assistantSettingsCopy as copy } from "../../../lib/i18n/messages/assistant-settings.js";

// A subpage inside a tab: back to the tab's list, the subpage title and an optional ⓘ.
export default function SubpageHeader({ title, tab, onBack, hint }) {
  const info = useInfoHint();
  return (
    <>
      <div className="agent-subpage-header">
        <button
          type="button"
          className="agent-subpage-back"
          aria-label={copy.backTo(copy.tabs[tab])}
          onClick={onBack}
        >
          <Icon name="back" />
        </button>
        <h2>{title}</h2>
        {hint && <InfoHintButton hint={info} />}
      </div>
      {hint && <InfoHintText hint={info}>{hint}</InfoHintText>}
    </>
  );
}
