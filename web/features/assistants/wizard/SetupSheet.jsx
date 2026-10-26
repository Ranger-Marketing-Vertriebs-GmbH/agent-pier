import React from "react";
import SidePanel from "../../../components/SidePanel.jsx";
import { routePath } from "../../../app/routes.js";
import { agentWizardCopy } from "../../../lib/i18n/messages/agent-wizard.js";

/**
 * "hier einrichten" / "+ … anlegen" (handoff 5.3 steps 3 and 4): a side sheet that
 * opens the place where the missing thing is set up in a new tab, so the wizard's
 * draft stays, and reads the source again when the owner comes back.
 */
export default function SetupSheet({ title, text, route, onRefresh, onClose }) {
  const copy = agentWizardCopy.access;
  return (
    <SidePanel
      title={title}
      close={onClose}
      cancelLabel={agentWizardCopy.connect.done}
      footer={
        <button
          type="button"
          className="button primary"
          onClick={async () => {
            await onRefresh?.();
            onClose();
          }}
        >
          {copy.refresh}
        </button>
      }
    >
      <div className="agent-wizard-sheet">
        {text && <p>{text}</p>}
        <p className="field-description">{copy.createSub}</p>
        <a
          className="button secondary"
          href={routePath(route)}
          target="_blank"
          rel="noopener noreferrer"
        >
          {copy.openPage}
        </a>
      </div>
    </SidePanel>
  );
}
