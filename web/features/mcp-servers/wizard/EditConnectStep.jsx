import React, { useState } from "react";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import AccountDetail from "../../accounts/AccountDetail.jsx";
import { itemRoute } from "../../accounts/accounts-items.js";
import McpCliStatus from "../McpCliStatus.jsx";
import usePackageStatus from "../usePackageStatus.js";
import { ConnectForm } from "./ConnectStep.jsx";
import ConnectResults from "./ConnectResults.jsx";
import { writeSwitch } from "./setting-hints.js";
import "./mcp-wizard.css";

/** Edit "Who may use it": the same switches and consent; results before returning. */
export default function EditConnectStep({ entry, data, navigate, agentsEnabled }) {
  const server = entry.record;
  const packageStatus = usePackageStatus(server.source ? server : null, data.reloadMcp);
  const [outcome, setOutcome] = useState(null);
  const back = () => navigate(itemRoute("mcp-servers", server.id));
  // Stored values are unreadable: a write switch can only be named as stored.
  const stored = (server.envNames || []).map((name) => ({
    key: name,
    name,
    value: "",
    stored: true,
  }));
  return (
    <AccountDetail title={server.name}>
      {outcome ? (
        <section className="mcp-wizard-step" aria-label={copy.done.changesSaved}>
          <h2 className="mcp-wizard-title">{copy.done.changesSaved}</h2>
          <McpCliStatus server={server} onChanged={data.reloadMcp} />
          <ConnectResults
            {...outcome}
            serverId={server.id}
            data={data}
            onChange={(results) => setOutcome({ ...outcome, results })}
          />
          <button type="button" className="button primary" onClick={back}>
            {copy.done.backToServer}
          </button>
        </section>
      ) : (
        <ConnectForm
          mode="edit"
          server={server}
          packageShown={packageStatus.shown}
          agentsEnabled={agentsEnabled}
          write={server.transport === "stdio" ? writeSwitch(stored) : null}
          data={data}
          navigate={navigate}
          titleTag="h2"
          onFinished={(results, context) => setOutcome({ results, ...context })}
          onSkip={back}
          skipLabel={copy.back}
        />
      )}
    </AccountDetail>
  );
}
