import React, { useState } from "react";
import Icon from "../../components/Icon.jsx";
import ListCard from "../../components/ListCard.jsx";
import ProviderMark from "../../components/ProviderMark.jsx";
import Sheet from "../../components/Sheet.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { extensionsHubCopy as hub } from "../../lib/i18n/messages/extensions.js";

// Phones: the header subtitle names the profile and opens the "CLI-Profile" sheet.
// The current row also carries the CLI's config path, which desktop shows in the
// detail header.
export default function ProfileSwitcher({
  profiles,
  selected,
  sub,
  configPath,
  locked,
  onSelect,
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="extension-profile-switch"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={hub.switchProfile(selected.name)}
        disabled={locked}
        onClick={() => setOpen(true)}
      >
        <span>{selected.name}</span>
        <Icon name="down" size={12} />
      </button>
      <Sheet
        open={open && !locked}
        title={hub.profiles}
        onCancel={() => setOpen(false)}
        className="extension-profile-sheet"
      >
        <div className="sheet-body">
          <ListCard label={hub.profiles}>
            {profiles.map((item) => {
              const current = item.id === selected.id;
              return (
                <div key={item.id} className="list-row two-line">
                  <button
                    type="button"
                    className="list-row-main"
                    aria-current={current ? "true" : undefined}
                    onClick={() => {
                      setOpen(false);
                      if (!current) onSelect(item.id);
                    }}
                  >
                    <ProviderMark tool={item.tool} small />
                    <span className="list-row-text">
                      <span className="list-row-label">{item.name}</span>
                      <span className="list-row-sub">
                        {sub(item)}
                        {current && configPath && (
                          <>
                            {" · "}
                            <code>{configPath}</code>
                          </>
                        )}
                      </span>
                    </span>
                    {current && (
                      <Icon name="check" size={16} className="extension-profile-check" />
                    )}
                  </button>
                </div>
              );
            })}
          </ListCard>
        </div>
        <div className="sheet-actions">
          <button
            type="button"
            className="button secondary"
            onClick={() => setOpen(false)}
          >
            {commonCopy.cancel}
          </button>
        </div>
      </Sheet>
    </>
  );
}
