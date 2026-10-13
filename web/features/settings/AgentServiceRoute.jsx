import React, { lazy, Suspense, useEffect, useRef } from "react";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { operationsCopy } from "../../lib/i18n/messages/operations.js";
import useAssistantFeature from "../assistants/useAssistantFeature.js";
import { SubpageFrame } from "./SettingsFrame.jsx";
import { tabRoot } from "./settings-navigation.js";
const AgentServicePage = lazy(() => import("./AgentServicePage.jsx"));

// The agent service needs agents switched on. While they are off, its old address
// (/settings/assistants) lands on the workspace tab, where the switch lives.
export default function AgentServiceRoute({ frame }) {
  const feature = useAssistantFeature();
  const off = !feature.loading && !feature.enabled;
  const { go } = frame;
  const redirected = useRef(false);
  useEffect(() => {
    if (!off || redirected.current) return;
    redirected.current = true;
    go(tabRoot("workspace"), true);
  }, [off, go]);
  const copy = assistantCopy.feature;
  const problem = feature.error
    ? copy.errors[feature.error] || copy.problem(feature.error)
    : "";
  const loading = (
    <SubpageFrame frame={frame} title={assistantCopy.runtime}>
      <p role="status">{operationsCopy.loading}</p>
    </SubpageFrame>
  );
  if (!feature.enabled) return loading;
  return (
    <Suspense fallback={loading}>
      <AgentServicePage
        frame={frame}
        diagnostic={problem && `${copy.diagnostic}: ${problem}`}
      />
    </Suspense>
  );
}
