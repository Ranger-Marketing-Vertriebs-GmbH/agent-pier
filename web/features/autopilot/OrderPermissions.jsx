import React from "react";
import ListCard from "../../components/ListCard.jsx";
import { ToggleRow } from "../../components/ListRow.jsx";
import { autopilotActionsCopy as copy } from "../../lib/i18n/messages/autopilot-actions.js";

export default function OrderPermissions({ policy, change }) {
  return (
    <ListCard label={copy.permissions}>
      <ToggleRow
        label={copy.implementationAuthorized}
        sub={copy.implementationHint}
        checked={policy.implementationAuthorized}
        onChange={(value) => change("implementationAuthorized", value)}
      />
      <ToggleRow
        label={copy.allowMerge}
        sub={copy.mergeHint}
        checked={policy.allowMerge}
        onChange={(value) => change("allowMerge", value)}
      />
    </ListCard>
  );
}
