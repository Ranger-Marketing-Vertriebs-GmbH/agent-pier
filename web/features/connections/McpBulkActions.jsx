import React, { useState } from "react";
import Checkbox from "../../components/Checkbox.jsx";
import CheckRow from "../../components/CheckRow.jsx";
import { names } from "../../lib/providers.js";
import { connectionsAreaCopy as copy } from "../../lib/i18n/messages/connections-area.js";
import { mcpWizardCopy } from "../../lib/i18n/messages/mcp-wizard.js";
import { assistantApi } from "../assistants/assistant-api.js";
import { clis } from "../mcp-servers/cli-support.js";
import { newestStable } from "../mcp-servers/mcp-package-versions.js";
import AgentChoice from "./AgentChoice.jsx";
import BulkDialog from "./BulkDialog.jsx";
import { mcpAgents } from "./agent-grants.js";
import { runEach } from "./bulk-run.js";
import { saveMcpBinding } from "./grant-api.js";
import { bindingError } from "./McpUsedBy.jsx";
import { boundClis } from "./connection-items.js";

const labelled = (results, label) =>
  results.map((result) => ({ ...result, label: label(result.item) }));

/** One package's update check: the newest stable version the registry lists. */
export async function checkUpdate(server) {
  if (!server.source) return copy.bulk.noPackage;
  const listed = await assistantApi.mcpPackageVersions(
    server.source.registry,
    server.source.name,
  );
  const newest = newestStable({
    latest: listed?.latest ?? null,
    versions: Array.isArray(listed?.versions) ? listed.versions : [],
  });
  return newest && newest !== server.source.version
    ? copy.bulk.updateTo(newest)
    : copy.bulk.upToDate;
}

/**
 * The bulk actions of the MCP list (handoff 5.6): bind to coding CLIs, grant agents,
 * check package updates and remove. Each calls the per-server (or per-agent) endpoint
 * the server overview and its Connect step use, and lists one result per item.
 */
export default function McpBulkActions({
  selected: current,
  assistants,
  data,
  onDone,
  onOpenChange,
}) {
  // A dialog keeps the selection it opened with (see SshBulkActions).
  const [frozen, setFrozen] = useState(null);
  const selected = frozen ?? current;
  const [open, setOpen] = useState("");
  const [chosen, setChosen] = useState([]);
  const [consent, setConsent] = useState(false);
  const stdio = selected.some((server) => server.transport === "stdio");
  const agents = mcpAgents(assistants);
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const ids = selected.map((server) => server.id);
  const show = (name) => {
    setFrozen(current);
    onOpenChange?.(true);
    setChosen([]);
    setConsent(false);
    setOpen(name);
  };
  const close = () => {
    setOpen("");
    setFrozen(null);
    onOpenChange?.(false);
  };
  const consentBox = stdio && (
    <div className="connections-consent">
      <p className="accounts-note">{mcpWizardCopy.connect.stdioRights}</p>
      <Checkbox label={copy.bulk.consent} checked={consent} onChange={setConsent} />
    </div>
  );
  const buttons = [
    ["bind", copy.bulk.bindCli, "primary"],
    ["grant", copy.bulk.grant, "secondary"],
    ["updates", copy.bulk.checkUpdates, "secondary"],
    ["remove", copy.bulk.remove, "destructive"],
  ];
  return (
    <>
      {buttons.map(([name, label, tone]) => (
        <button
          key={name}
          type="button"
          className={`button ${tone} compact`}
          onClick={() => show(name)}
        >
          {label}
        </button>
      ))}
      {open === "bind" && (
        <BulkDialog
          title={copy.bulk.bindTitle(ids.length)}
          intro={copy.bulk.bindBody}
          confirmLabel={copy.bulk.bindButton}
          confirmDisabled={!chosen.length || (stdio && !consent)}
          run={async (onProgress) => {
            // Read now: a saved server's revision moves with every install or edit.
            const fresh = (await data.reloadMcp()) || [];
            const results = await runEach(
              selected,
              async (server) => {
                const current = fresh.find((item) => item.id === server.id);
                if (!current) throw new Error(copy.bulk.gone);
                const { clis: wanted, unsupported } = boundClis(current, chosen);
                await assistantApi.updateMcpServer(server.id, {
                  revision: current.revision,
                  clis: wanted,
                  ...(current.transport === "stdio" ? { confirmStdio: true } : {}),
                });
                return unsupported
                  .map((cli) => copy.bulk.unsupported(names[cli]))
                  .join(" ");
              },
              { onProgress },
            );
            return labelled(results, (server) => server.name).map((result) =>
              result.ok && result.value ? { ...result, detail: result.value } : result,
            );
          }}
          close={close}
          onDone={onDone}
        >
          <fieldset className="connections-agent-choice">
            <legend>{mcpWizardCopy.connect.clis}</legend>
            <div className="connections-agent-list">
              {clis.map((cli) => (
                <CheckRow
                  key={cli}
                  title={names[cli]}
                  checked={chosen.includes(cli)}
                  onChange={(event) =>
                    setChosen(
                      event.target.checked
                        ? [...chosen, cli]
                        : chosen.filter((value) => value !== cli),
                    )
                  }
                />
              ))}
            </div>
          </fieldset>
          {consentBox}
        </BulkDialog>
      )}
      {open === "grant" && (
        <BulkDialog
          title={copy.bulk.grantMcpTitle(ids.length)}
          confirmLabel={copy.bulk.grantButton(chosen.length)}
          confirmDisabled={!chosen.length || (stdio && !consent)}
          run={(onProgress) =>
            runEach(
              chosen,
              (agentId) =>
                saveMcpBinding(agentId, ids, {
                  add: true,
                  confirmStdio: stdio && consent,
                }),
              { onProgress },
            ).then((results) =>
              labelled(results, (agentId) => agentNames.get(agentId) || agentId).map(
                (result) =>
                  result.ok
                    ? result
                    : { ...result, error: { message: bindingError(result.error) } },
              ),
            )
          }
          close={close}
          onDone={onDone}
        >
          <AgentChoice agents={agents} chosen={chosen} onChange={setChosen} />
          {consentBox}
        </BulkDialog>
      )}
      {open === "updates" && (
        <BulkDialog
          title={copy.bulk.checkUpdates}
          autoStart
          run={(onProgress) =>
            runEach(selected, checkUpdate, { parallel: 2, onProgress }).then((results) =>
              labelled(results, (server) => server.name).map((result) =>
                result.ok ? { ...result, detail: result.value } : result,
              ),
            )
          }
          close={close}
        />
      )}
      {open === "remove" && (
        <BulkDialog
          title={copy.bulk.removeTitle(ids.length)}
          intro={copy.bulk.removeBody}
          confirmLabel={copy.bulk.removeNow}
          destructive
          run={(onProgress) =>
            runEach(selected, (server) => assistantApi.removeMcpServer(server.id), {
              onProgress,
            }).then((results) => labelled(results, (server) => server.name))
          }
          close={close}
          onDone={onDone}
        >
          <ul className="connections-bulk-names">
            {selected.map((server) => (
              <li key={server.id}>{server.name}</li>
            ))}
          </ul>
        </BulkDialog>
      )}
    </>
  );
}
