import React, { Suspense, useCallback } from "react";
import SidePanel from "../../../components/SidePanel.jsx";
import useResource from "../../../lib/useResource.js";
import { agentWizardCopy } from "../../../lib/i18n/messages/agent-wizard.js";
import { operationsCopy } from "../../../lib/i18n/messages/operations.js";
import { detailComponents } from "../../accounts/account-details.js";
import useAccountsData from "../../accounts/useAccountsData.js";
import "../../accounts/accounts.css";
import "../../accounts/accounts-page.css";

/**
 * "hier einrichten" for a service of Zugänge › Dienste für Agenten (handoff 5.3 step
 * 3): its own form (web search, speech, PDF model) in a side sheet, with its save bar
 * and restart question. The wizard's draft stays; closing reads the service again.
 * `kind` is the entry kind of accounts-items.js: "web-search", "speech", "pdf-model".
 */
export default function ServiceSheet({ kind, title, onClose }) {
  const data = useAccountsData({ agentsEnabled: true });
  const connections = useResource("/provider-connections");
  const Detail = detailComponents[kind];
  // Links inside the form (e.g. "Benutzt von") would leave the wizard: the sheet
  // stays instead; the agent's own settings show the same after creating.
  const stay = useCallback(() => {}, []);
  return (
    <SidePanel
      title={title}
      subtitle={agentWizardCopy.connect.subtitle}
      close={onClose}
      cancelLabel={agentWizardCopy.connect.done}
    >
      <div className="agent-wizard-sheet">
        <Suspense fallback={<p role="status">{operationsCopy.loading}</p>}>
          <Detail
            entry={{ kind, section: "services", item: kind, record: null }}
            usage={null}
            agentsEnabled
            state={{ providerConnections: connections.data?.connections || [] }}
            data={data}
            refresh={data.reloadWebSearch}
            navigate={stay}
          />
        </Suspense>
      </div>
    </SidePanel>
  );
}
