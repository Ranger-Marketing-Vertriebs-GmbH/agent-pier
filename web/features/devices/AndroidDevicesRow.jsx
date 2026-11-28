import React from "react";
import ListRow, { unknownValue } from "../../components/ListRow.jsx";
import { routePath } from "../../app/routes.js";
import { devicesCopy as copy } from "../../lib/i18n/messages/devices.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { subpage } from "../settings/settings-navigation.js";
import { featureState, validInstallation } from "./device-view.js";

const devicesRoute = subpage("devices");

/**
 * The row of Settings › General › Features that opens Android devices and shows the
 * state of their installation, which follows the live topic `devices.installation`.
 */
export default function AndroidDevicesRow({ frame }) {
  const topic = useLiveTopic("devices.installation");
  const state = validInstallation(topic.data) ? featureState(topic.data) : null;
  return (
    <ListRow
      label={copy.title}
      sub={copy.featureSub}
      status={state && state.tone !== "idle" ? state : undefined}
      value={state ? (state.tone === "idle" ? state.text : undefined) : unknownValue}
      href={routePath(devicesRoute)}
      onClick={() => frame.go(devicesRoute)}
    />
  );
}
