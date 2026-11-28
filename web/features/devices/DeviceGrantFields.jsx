import React, { useId } from "react";
import GrantPicker from "../../components/GrantPicker.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import { ToggleRow } from "../../components/ListRow.jsx";
import { devicesCopy } from "../../lib/i18n/messages/devices.js";
import {
  deviceGrantEntries,
  grantedIds,
  manageRows,
  withGranted,
  withManage,
} from "./session-device-access.js";
import "./device-grants.css";

/**
 * The devices one session may use, as a draft (`{ devices: [{ deviceId, manage }],
 * create }`, session-device-access.js): the grant picker over `devices`
 * (`[{ id, name, own? }]`), below it the permissions, one "reset and delete" switch
 * per granted device and "Create devices". `stacked` and `heading` are GrantPicker's;
 * the new-session dialog uses both. `onChange(draft)` hands on the next draft.
 */
export default function DeviceGrantFields({
  devices,
  draft,
  onChange,
  heading,
  stacked = false,
  disabled = false,
  autoFocus = false,
}) {
  const { access: copy } = devicesCopy;
  const id = useId();
  return (
    <GrantPicker
      stacked={stacked}
      entries={deviceGrantEntries(devices)}
      selected={grantedIds(draft)}
      onChange={(ids) => onChange(withGranted(draft, ids))}
      typeLabel={copy.grantType}
      listLabel={copy.listLabel}
      heading={heading}
      disabled={disabled}
      autoFocus={autoFocus}
      emptyText={copy.empty}
    >
      <div className="device-grant-permissions">
        <GroupLabel as="h3" id={`${id}-permissions`}>
          {copy.permissions}
        </GroupLabel>
        <ListCard labelledBy={`${id}-permissions`}>
          {manageRows(draft, devices).map((row) => (
            <ToggleRow
              key={row.id}
              label={copy.manage(row.name)}
              checked={row.manage}
              disabled={disabled}
              onChange={(manage) => onChange(withManage(draft, row.id, manage))}
            />
          ))}
          <ToggleRow
            label={copy.create}
            sub={copy.createSub}
            checked={draft.create}
            disabled={disabled}
            onChange={(create) => onChange({ ...draft, create })}
          />
        </ListCard>
      </div>
    </GrantPicker>
  );
}
