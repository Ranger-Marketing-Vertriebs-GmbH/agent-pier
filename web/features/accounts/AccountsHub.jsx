import React, { useId } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow, { unknownValue } from "../../components/ListRow.jsx";
import { routePath } from "../../app/routes.js";
import { accountsHubCopy as hubCopy } from "../../lib/i18n/messages/accounts.js";
import { assistantPdfCopy as pdfCopy } from "../../lib/i18n/messages/assistant-pdf.js";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { connectionSummary } from "../provider-connections/connection-summary.js";
import useAssistants from "../assistants/useAssistants.js";
import AddLabel from "./AddLabel.jsx";
import { itemRoute } from "./accounts-items.js";
import { usageEntry, usageValue } from "./account-usage-view.js";

function HubGroup({ title, hint, action, children }) {
  const id = useId();
  return (
    <section className="accounts-group" aria-labelledby={`${id}-label`}>
      <GroupLabel id={`${id}-label`} hint={hint} action={action}>
        {title}
      </GroupLabel>
      {typeof children === "function" ? children(`${id}-label`) : children}
    </section>
  );
}

function ItemRow({ section, id, selected, navigate, ...row }) {
  const route = itemRoute(section, id);
  const current = selected?.section === section && selected.item === id;
  return (
    <ListRow
      {...row}
      href={routePath(route)}
      onClick={() => navigate(route)}
      current={current}
      className={current ? "is-selected" : ""}
    />
  );
}

/**
 * The entry lists of model access and services for agents (Zugänge); `groups` names
 * the ones a page shows. Native CLI accounts are listed by Coding › Accounts
 * (web/features/coding/accounts/).
 */
export default function AccountsHub({
  state,
  data,
  usage,
  agentsEnabled,
  selected,
  navigate,
  groups = ["models", "services"],
}) {
  const { runtime } = useAssistants();
  const ready = runtime.availability === "ready";
  const connections = state.providerConnections || [];
  const row = { selected, navigate };
  const speech = assistantCopy.speech;
  const webSearch = assistantCopy.webSearch;
  return (
    <div className="accounts-hub">
      <p className="accounts-intro">{hubCopy.intro}</p>
      {groups.includes("models") && (
        <HubGroup
          title={hubCopy.groups.models}
          hint={connectionCopy.description}
          action={{
            label: <AddLabel text={connectionCopy.add} />,
            onClick: () => navigate(itemRoute("models", "new")),
          }}
        >
          {(labelId) => (
            <>
              {agentsEnabled && <ErrorMessage error={data.chatgptError} />}
              {!connections.length && (
                <p className="accounts-note">{connectionCopy.empty}</p>
              )}
              <ListCard labelledBy={labelId}>
                {connections.map((connection) => (
                  <ItemRow
                    key={connection.id}
                    section="models"
                    id={connection.id}
                    {...row}
                    label={connection.name}
                    sub={connectionSummary(connection).join(" · ")}
                    value={usageValue(usageEntry(usage, "connection", connection.id))}
                  />
                ))}
                {agentsEnabled &&
                  (data.chatgpt || []).map((account) => (
                    <ItemRow
                      key={account.id}
                      section="models"
                      id={account.id}
                      {...row}
                      label={account.name}
                      sub={hubCopy.chatgptSub(
                        assistantCopy.accountStatus[ready ? account.status : "offline"] ||
                          assistantCopy.accountStatus.unknown,
                      )}
                      value={usageValue(usageEntry(usage, "chatgpt", account.id))}
                    />
                  ))}
                {agentsEnabled && (
                  <ItemRow
                    section="models"
                    id="chatgpt"
                    {...row}
                    label={assistantCopy.accountsTitle}
                    sub={hubCopy.chatgptConnectSub}
                  />
                )}
              </ListCard>
            </>
          )}
        </HubGroup>
      )}
      {agentsEnabled && groups.includes("services") && (
        <HubGroup title={hubCopy.groups.services}>
          {(labelId) => (
            <>
              <ErrorMessage error={data.speechError} />
              <ErrorMessage error={data.webSearchError} />
              <ErrorMessage error={data.pdfModelError} />
              <ListCard labelledBy={labelId}>
                <ItemRow
                  section="services"
                  id="speech"
                  {...row}
                  label={speech.title}
                  sub={
                    data.speech
                      ? `${hubCopy.speechProvider} · ${data.speech.hasSecret ? speech.saved : speech.missing}`
                      : unknownValue
                  }
                  value={usageValue(usageEntry(usage, "speech"))}
                />
                <ItemRow
                  section="services"
                  id="web-search"
                  {...row}
                  label={webSearch.title}
                  sub={
                    data.webSearch
                      ? `${hubCopy.searchProviders[data.webSearch.provider] ?? data.webSearch.provider} · ${data.webSearch.ready ? webSearch.ready : hubCopy.notReady}`
                      : unknownValue
                  }
                  value={usageValue(usageEntry(usage, "web-search"))}
                />
                <ItemRow
                  section="services"
                  id="pdf-model"
                  {...row}
                  label={pdfCopy.title}
                  sub={
                    data.pdfModel
                      ? data.pdfModel.modelId
                        ? `${data.pdfModel.modelId} · ${data.pdfModel.ready ? pdfCopy.ready : hubCopy.notReady}`
                        : pdfCopy.notSet
                      : unknownValue
                  }
                  value={usageValue(usageEntry(usage, "pdf-model"))}
                />
              </ListCard>
            </>
          )}
        </HubGroup>
      )}
    </div>
  );
}
