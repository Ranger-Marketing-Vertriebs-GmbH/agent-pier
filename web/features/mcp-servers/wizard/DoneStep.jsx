import React from "react";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { itemRoute } from "../../accounts/accounts-items.js";
import McpCliStatus from "../McpCliStatus.jsx";
import { McpOAuthActions } from "../McpOAuthLogin.jsx";
import { usesOAuth } from "../McpOAuthStatus.jsx";
import ConnectResults from "./ConnectResults.jsx";
import { storedCount } from "./setting-hints.js";
import WizardStep from "./WizardStep.jsx";
import { pasteLeft } from "./wizard-state.js";

const noConnect = { results: [], diff: null, consented: false };

/** "<name> is ready": the package, each CLI and agent, the settings and what is next. */
export default function DoneStep({
  state,
  dispatch,
  headingRef,
  server,
  packageStatus,
  data,
  navigate,
  agentsEnabled,
  oauth,
}) {
  if (!server) return null;
  const connect = state.connect ?? noConnect;
  const shown = packageStatus.shown;
  const failed =
    connect.results.some((item) => !item.ok) || ["failed", "missing"].includes(shown);
  const rows = server.transport === "stdio" ? state.draft.env : state.draft.headers;
  const agentLogin =
    agentsEnabled &&
    oauth &&
    usesOAuth(server) &&
    connect.results.some(
      (item) => item.ok && item.target.kind === "agent" && item.target.add,
    );
  return (
    <WizardStep
      title={(failed ? copy.done.saved : copy.done.ready)(server.name)}
      headingRef={headingRef}
      primary={{ label: copy.done.open }}
      secondary={{
        label: copy.done.another,
        onClick: () => {
          // The other servers of a pasted block wait here; closing drops them.
          const rest = pasteLeft(state.paste);
          dispatch({ type: "reset", keepPaste: rest });
          navigate(itemRoute("mcp-servers", "new", rest ? "paste" : undefined));
        },
      }}
      onSubmit={() => navigate(itemRoute("mcp-servers", server.id))}
    >
      {server.source && (
        <section className="mcp-wizard-card-block" aria-label={copy.done.package}>
          <h2 className="mcp-wizard-subtitle">{copy.done.package}</h2>
          <p>
            <span className="mcp-wizard-mono">{`${server.source.name} ${server.source.version}`}</span>
            {" · "}
            {copy.done.packageStates[shown] ?? shown}
          </p>
        </section>
      )}
      {server.clis?.length > 0 && (
        <section className="mcp-wizard-card-block" aria-label={copy.done.clis}>
          <h2 className="mcp-wizard-subtitle">{copy.done.clis}</h2>
          <McpCliStatus server={server} onChanged={data.reloadMcp} />
        </section>
      )}
      <ConnectResults
        results={connect.results}
        diff={connect.diff}
        consented={connect.consented}
        serverId={server.id}
        data={data}
        onChange={(results) => dispatch({ type: "connected", ...connect, results })}
      />
      <section className="mcp-wizard-card-block" aria-label={copy.done.settings}>
        <h2 className="mcp-wizard-subtitle">{copy.done.settings}</h2>
        <p>{copy.done.settingsStored(storedCount(rows ?? []))}</p>
      </section>
      <section className="mcp-wizard-card-block" aria-label={copy.done.next}>
        <h2 className="mcp-wizard-subtitle">{copy.done.next}</h2>
        <p>{copy.done.restart}</p>
        {agentLogin && (
          <div className="mcp-actions">
            <McpOAuthActions server={server} oauth={oauth} />
          </div>
        )}
      </section>
    </WizardStep>
  );
}
