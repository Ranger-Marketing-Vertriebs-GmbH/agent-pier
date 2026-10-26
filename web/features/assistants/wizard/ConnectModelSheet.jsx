import React, { Suspense, lazy, useCallback, useState } from "react";
import Segmented from "../../../components/Segmented.jsx";
import SidePanel from "../../../components/SidePanel.jsx";
import { agentWizardCopy } from "../../../lib/i18n/messages/agent-wizard.js";
import { operationsCopy } from "../../../lib/i18n/messages/operations.js";
import useAssistants from "../useAssistants.js";
import "../../accounts/accounts.css";
import "../../accounts/accounts-page.css";

const ChatgptLoginDetail = lazy(() => import("../ChatgptLoginDetail.jsx"));
const ConnectionDetail = lazy(
  () => import("../../provider-connections/ConnectionDetail.jsx"),
);

const copy = () => agentWizardCopy.connect;
const entries = {
  chatgpt: { kind: "chatgpt-login", section: "models", item: "chatgpt", record: null },
  provider: { kind: "connection-new", section: "models", item: "new", record: null },
};

/**
 * "+ Modell verbinden" (handoff 5.3 step 2): the existing model access flows of
 * Zugänge › Modell-Zugänge (ChatGPT device code, a new provider access) in a side
 * sheet. A saved access refreshes the model list; the flows' own "show the new entry"
 * navigation only closes the sheet, so the wizard and its draft stay.
 */
export default function ConnectModelSheet({ onClose }) {
  const { refresh } = useAssistants();
  const [kind, setKind] = useState("chatgpt");
  const [done, setDone] = useState(false);
  const reload = useCallback(async () => {
    await refresh();
  }, [refresh]);
  const finish = useCallback(async () => {
    await refresh();
    setDone(true);
  }, [refresh]);
  // The flows navigate to the entry they created: here the sheet reports it instead.
  const stay = useCallback(() => {
    finish();
  }, [finish]);
  const Detail = kind === "chatgpt" ? ChatgptLoginDetail : ConnectionDetail;
  return (
    <SidePanel
      title={copy().title}
      subtitle={copy().subtitle}
      close={onClose}
      cancelLabel={copy().done}
    >
      <div className="agent-wizard-sheet">
        <Segmented
          label={copy().title}
          value={kind}
          onChange={(next) => {
            setKind(next);
            setDone(false);
          }}
          options={[
            { value: "chatgpt", label: copy().chatgpt },
            { value: "provider", label: copy().provider },
          ]}
        />
        <p className="field-description">
          {kind === "chatgpt" ? copy().chatgptSub : copy().providerSub}
        </p>
        {done && (
          <p role="status" className="assistant-notice">
            {copy().connected}
          </p>
        )}
        <Suspense fallback={<p role="status">{operationsCopy.loading}</p>}>
          <Detail
            key={kind}
            entry={entries[kind]}
            usage={null}
            agentsEnabled
            data={{ reloadChatgpt: finish }}
            refresh={reload}
            navigate={stay}
          />
        </Suspense>
      </div>
    </SidePanel>
  );
}
