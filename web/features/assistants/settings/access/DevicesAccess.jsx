import React, { useId } from "react";
import ErrorMessage from "../../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../../components/GroupLabel.jsx";
import Icon from "../../../../components/Icon.jsx";
import ListCard from "../../../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../../../components/ListRow.jsx";
import ReferenceRow from "../../../../components/ReferenceRow.jsx";
import { routePath } from "../../../../app/routes.js";
import { useCrossLink } from "../../../../app/cross-link.js";
import { commonCopy } from "../../../../lib/i18n/messages/common.js";
import { devicesCopy } from "../../../../lib/i18n/messages/devices.js";
import DeviceGrantFields from "../../../devices/DeviceGrantFields.jsx";
import {
  agentAccessBlocked,
  allowedHeading,
  keptAssignment,
  orderedDraft,
  passedDevices,
} from "../../../devices/agent-device-access.js";
import { subpage } from "../../../settings/settings-navigation.js";
import "../../../devices/device-grants.css";

/**
 * Android devices in an agent's Access tab: the devices the agent may use, per device
 * "Reset and delete", and "Create devices" (DeviceGrantFields), edited in the tab's
 * draft (`value`, `onChange`) and saved with its bar. `devices` is useAgentDevices;
 * the caller shows the group only while the host offers devices. An agent that cannot
 * be given devices reads why and gets no choice. A device its lead passes on with an
 * open task is listed below, read only. `member` adds what a lead can do.
 */
export default function DevicesAccess({
  devices,
  value,
  onChange,
  disabled,
  member = false,
  navigate,
}) {
  const { agent: copy } = devicesCopy;
  const id = useId();
  const crossLink = useCrossLink();
  const { access, error } = devices;
  const blocked = access ? agentAccessBlocked(access) : "";
  const passed = access && !blocked ? passedDevices(access) : [];
  const page = crossLink(subpage("devices"));
  return (
    <section id="agent-access-devices" aria-labelledby={id}>
      <GroupLabel id={id} hint={copy.hint}>
        {devicesCopy.title}
      </GroupLabel>
      {!access && <ErrorMessage error={error} />}
      {!access && !error && (
        <ListCard labelledBy={id}>
          <ListRow label={devicesCopy.title} value={unknownValue} />
        </ListCard>
      )}
      {blocked && (
        <p className="agent-locked-notice" role="note" data-agent-devices-blocked>
          <Icon name="shield" size={16} />
          <span>
            {blocked}
            {keptAssignment(access) ? ` ${copy.kept}` : ""}
          </span>
        </p>
      )}
      {access && !blocked && (
        <>
          <DeviceGrantFields
            stacked
            devices={access.devices}
            draft={value}
            onChange={(next) => onChange(orderedDraft(next))}
            heading={allowedHeading(value, access.devices)}
            ownNote={copy.own}
            createSub={copy.createSub}
            disabled={disabled}
          />
          {passed.length > 0 && (
            <>
              <GroupLabel as="h3" id={`${id}-passed`}>
                {copy.passed}
              </GroupLabel>
              <ListCard labelledBy={`${id}-passed`}>
                {passed.map((device) => (
                  <ListRow key={device.id} label={device.name} sub={copy.passedSub} />
                ))}
              </ListCard>
            </>
          )}
          <p className="assistant-note agent-devices-rules" data-agent-devices-rules>
            {copy.runs}
            {member ? ` ${copy.member}` : ""}
          </p>
          <ReferenceRow
            title={copy.manage}
            sub=""
            linkLabel={commonCopy.settings}
            href={routePath(page)}
            onOpen={() => navigate(page)}
          />
        </>
      )}
    </section>
  );
}
