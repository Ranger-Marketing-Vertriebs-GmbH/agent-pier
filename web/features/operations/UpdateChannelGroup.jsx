import React from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import { RadioRow } from "../../components/ListRow.jsx";
import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";

// The selected channel's help stays visible; the others' help is behind ⓘ.
export default function UpdateChannelGroup({ releases, value, onChange, disabled }) {
  const managed = Boolean(releases.updateChannelManaged);
  const options = [
    { value: "stable", label: copy.channelStable, help: copy.channelStableHelp },
    { value: "preview", label: copy.channelPreview, help: copy.channelPreviewHelp },
    ...(managed
      ? [{ value: "custom", label: copy.channelCustom, help: copy.channelManagedHelp }]
      : []),
  ];
  return (
    <>
      <GroupLabel id="update-channel-label">{copy.channel}</GroupLabel>
      <ListCard labelledBy="update-channel-label" className="update-channel">
        {options.map((option) => (
          <RadioRow
            key={option.value}
            name="update-channel"
            value={option.value}
            label={option.label}
            checked={value === option.value}
            disabled={disabled || managed}
            onChange={onChange}
            {...(value === option.value ? { sub: option.help } : { hint: option.help })}
          />
        ))}
      </ListCard>
    </>
  );
}
