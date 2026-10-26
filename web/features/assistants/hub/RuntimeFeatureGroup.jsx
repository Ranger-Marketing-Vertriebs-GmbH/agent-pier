import React, { useEffect, useId } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow, { ToggleRow } from "../../../components/ListRow.jsx";
import { agentsHubCopy } from "../../../lib/i18n/messages/agents-hub.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { FEATURE_CHECK_FAILED } from "../useAssistantFeature.js";

const featureCopy = () => assistantCopy.feature;

/** The feature store's problem in words, or "" when there is none. */
export function featureDiagnostic(feature) {
  if (!feature.error) return "";
  return featureCopy().errors[feature.error] || featureCopy().problem(feature.error);
}

/**
 * Laufzeit › Funktion (moved from Einstellungen › Arbeitsbereich): the "Agenten
 * aktivieren" switch in the tab's draft and the "Agenten-Diagnose" row. Opening it
 * re-checks a feature state that could not be read, as the settings tab did.
 */
export default function RuntimeFeatureGroup({ draft, feature }) {
  const id = useId();
  const retry = feature.retry;
  useEffect(retry, [retry]);
  const diagnostic = featureDiagnostic(feature);
  return (
    <section aria-labelledby={id}>
      <GroupLabel id={id}>{agentsHubCopy.runtime.feature}</GroupLabel>
      <ListCard labelledBy={id}>
        <ToggleRow
          label={featureCopy().title}
          hint={featureCopy().description}
          checked={draft.values.agentsEnabled === true}
          disabled={
            feature.loading || feature.error === FEATURE_CHECK_FAILED || draft.saving
          }
          onChange={(on) => draft.set("agentsEnabled", on)}
        />
        <ListRow
          label={featureCopy().diagnostic}
          sub={diagnostic || agentsHubCopy.runtime.diagnosticOk}
        />
      </ListCard>
      <ErrorMessage error={diagnostic && `${featureCopy().diagnostic}: ${diagnostic}`} />
    </section>
  );
}
