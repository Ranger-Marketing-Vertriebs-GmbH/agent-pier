import React, { useCallback, useState } from "react";
import SidePanel from "../../../components/SidePanel.jsx";
import { screenOf } from "../../../app/route-screens.js";
import { agentWizardCopy } from "../../../lib/i18n/messages/agent-wizard.js";
import { mcpWizardCopy } from "../../../lib/i18n/messages/mcp-wizard.js";
import useAccountsData from "../../accounts/useAccountsData.js";
import { useMcpOAuth } from "../../mcp-servers/McpOAuthLogin.jsx";
import McpWizard from "../../mcp-servers/wizard/McpWizard.jsx";
import "../../accounts/accounts.css";
import "../../accounts/accounts-page.css";

/**
 * "+ MCP-Server anlegen" (handoff 5.3 step 4): the MCP wizard of Zugänge in a side
 * sheet. Its steps live in the sheet instead of the address, so the agent wizard and
 * its draft stay. The wizard's "open the server" (or closing it once saved) hands the
 * new server to `onCreated`; its close without a server only closes the sheet. Other
 * links (agent settings, Settings) leave through the app, which asks first.
 */
export default function McpSheet({ navigate, onCreated, onClose }) {
  const data = useAccountsData({ agentsEnabled: true });
  const [notice, setNotice] = useState("");
  const oauth = useMcpOAuth({ reload: data.reloadMcp, notify: setNotice });
  const [step, setStep] = useState("");
  const inSheet = useCallback(
    (route, replace) => {
      const next = screenOf(route) || route;
      if (
        ["accounts", "connections"].includes(next?.view) &&
        next.section === "mcp-servers"
      ) {
        if (next.item === "new") return setStep(next.step || "");
        if (next.item) return onCreated({ id: next.item });
        return onClose();
      }
      return navigate(route, replace);
    },
    [navigate, onCreated, onClose],
  );
  return (
    <SidePanel
      title={mcpWizardCopy.newTitle}
      subtitle={agentWizardCopy.connect.subtitle}
      close={onClose}
    >
      <div className="agent-wizard-sheet agent-wizard-mcp">
        {notice && (
          <p role="status" className="assistant-notice">
            {notice}
          </p>
        )}
        <McpWizard
          entry={{
            kind: "mcp-new",
            section: "mcp-servers",
            item: "new",
            ...(step ? { step } : {}),
          }}
          data={data}
          navigate={inSheet}
          agentsEnabled
          oauth={oauth}
          notifyMcp={setNotice}
        />
      </div>
    </SidePanel>
  );
}
