import React from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { accountsHubCopy } from "../../lib/i18n/messages/accounts.js";
import EndpointFields from "./EndpointFields.jsx";
import EndpointTestResult from "./EndpointTestResult.jsx";
import EndpointRouting from "./EndpointRouting.jsx";
import EndpointAdapterOptions from "./EndpointAdapterOptions.jsx";
import EndpointModelTable from "./EndpointModelTable.jsx";
import { applyProposal } from "./endpoint-draft.js";

/** An own endpoint's groups: connection, test, routing per CLI, adapter, models. */
export default function ConnectionEndpointGroups({
  endpoint,
  setEndpoint,
  editAddress,
  tester,
  probeModelId,
  setProbeModel,
}) {
  const copy = connectionCopy.endpoint;
  // A test model that left the list falls back to "Automatic".
  const probe = endpoint.models.some((model) => model.modelId === probeModelId)
    ? probeModelId
    : "";
  return (
    <>
      <section className="accounts-detail-group">
        <GroupLabel>{accountsHubCopy.connectionGroups.connection}</GroupLabel>
        <div className="connection-fields">
          <EndpointFields draft={endpoint} setDraft={editAddress} locked={false} />
        </div>
      </section>
      <section className="accounts-detail-group">
        <GroupLabel>{accountsHubCopy.connectionGroups.test}</GroupLabel>
        <div className="endpoint-test">
          <label>
            {copy.probeModel}
            <AnchoredSelect
              label={copy.probeModel}
              value={probe}
              onChange={setProbeModel}
              options={[
                { value: "", label: copy.probeAuto },
                ...endpoint.models.map((model) => ({
                  value: model.modelId,
                  label: model.modelId,
                })),
              ]}
            />
            <small>{copy.probeHint}</small>
          </label>
          <button
            type="button"
            className="button secondary"
            disabled={tester.busy || !endpoint.openaiBaseUrl.trim()}
            onClick={async () => {
              const proposal = await tester.run(probe);
              if (proposal) setEndpoint((current) => applyProposal(current, proposal));
            }}
          >
            {tester.busy ? copy.testing : copy.test}
          </button>
          <small>{copy.testCost}</small>
          <ErrorMessage error={tester.error} />
        </div>
        <EndpointTestResult
          draft={endpoint}
          setDraft={setEndpoint}
          result={tester.result}
        />
      </section>
      <EndpointRouting draft={endpoint} setDraft={setEndpoint} />
      <EndpointAdapterOptions draft={endpoint} setDraft={setEndpoint} />
      <EndpointModelTable draft={endpoint} setDraft={setEndpoint} />
    </>
  );
}
