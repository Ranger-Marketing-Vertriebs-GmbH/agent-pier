import React from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import { RadioRow } from "../../components/ListRow.jsx";
import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";
import { isPrerelease } from "./PrereleaseBadge.jsx";

const unsupportedId = "update-channel-unsupported";

// The selected channel's help stays visible; the others' help is behind ⓘ. Why the
// selection is locked (source checkout, unsupported platform) stays visible too.
export default function UpdateChannelGroup({
  releases,
  staged = [],
  value,
  onChange,
  disabled,
}) {
  const managed = Boolean(releases.updateChannelManaged);
  const unsupported = !releases.supported;
  const stableHelp = staged.some((release) => isPrerelease(release.version))
    ? `${copy.channelStableHelp} ${copy.stagedPrereleaseHelp}`
    : copy.channelStableHelp;
  const managedHelp = [
    copy.channelManagedHelp,
    releases.channel && copy.channelManagedSource(releases.channel),
  ]
    .filter(Boolean)
    .join(" ");
  const options = [
    { value: "stable", label: copy.channelStable, help: stableHelp },
    { value: "preview", label: copy.channelPreview, help: copy.channelPreviewHelp },
    ...(managed
      ? [{ value: "custom", label: copy.channelCustom, help: managedHelp }]
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
            disabled={disabled || managed || unsupported}
            onChange={onChange}
            describedBy={unsupported ? unsupportedId : undefined}
            {...(value === option.value ? { sub: option.help } : { hint: option.help })}
          />
        ))}
      </ListCard>
      {unsupported && (
        <p className="field-description" id={unsupportedId}>
          {copy.channelUnsupportedHelp}
        </p>
      )}
    </>
  );
}
