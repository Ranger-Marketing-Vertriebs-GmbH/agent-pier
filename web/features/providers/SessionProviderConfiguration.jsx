import React from "react";
import { providerCopy as copy } from "../../lib/i18n/de/providers.js";
import ProviderModelDetails from "./ProviderModelDetails.jsx";
export default function SessionProviderConfiguration({
  configuration,
  requiresRestart,
  tool,
}) {
  if (!configuration) return null;
  return (
    <div className="session-provider-configuration">
      <p>
        {copy.configuredModel(configuration.requestedModelId || configuration.modelId)}
      </p>
      {requiresRestart && <p>{copy.restart}</p>}
      <details>
        <summary>{copy.modelDetails}</summary>
        <ProviderModelDetails model={configuration} tool={tool} />
      </details>
    </div>
  );
}
