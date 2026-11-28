import React, { useId, useState } from "react";
import ConfirmDialog from "../../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import { formatBytes } from "../../../lib/format-bytes.js";
import { locale } from "../../../lib/i18n/index.js";
import { assistantSemanticMemoryCopy as copy } from "../../../lib/i18n/messages/assistant-semantic-memory.js";
import useLiveTopic from "../../../lib/live/useLiveTopic.js";
import { assistantApi } from "../assistant-api.js";
import {
  semanticMemoryView,
  switchRefusal,
  validSemanticMemory,
} from "./semantic-memory-view.js";
import "../agent-settings.css";

export const semanticMemorySection = "agents-runtime-memory-search";

/**
 * The owner's semantic memory search on the Runtime tab: its state, which follows
 * the live `runtime.semantic-memory` topic (each step of the download and of the
 * index rebuild is pushed), and the switch. Switching is an action of its own, never
 * part of the tab's draft: it restarts the agent service, so it asks first and says
 * what is interrupted.
 */
export default function SemanticMemoryGroup() {
  const id = useId();
  const topic = useLiveTopic("runtime.semantic-memory");
  const [confirming, setConfirming] = useState("");
  const status = validSemanticMemory(topic.data) ? topic.data : null;
  if (!status)
    return topic.error ? (
      <section id={semanticMemorySection} aria-labelledby={id}>
        <GroupLabel id={id}>{copy.title}</GroupLabel>
        <ErrorMessage error={topic.error} />
      </section>
    ) : null;
  const bytes = (value) => formatBytes(value, locale);
  const size = bytes(status.model?.size || 0);
  const view = semanticMemoryView(status, bytes);
  const apply = async (enabled, repair = false) => {
    try {
      await assistantApi.setSemanticMemory({
        enabled,
        revision: status.revision,
        ...(repair ? { repair: true } : enabled && { acceptTerms: true }),
      });
    } catch (error) {
      // A state that changed elsewhere shows before the refusal is read.
      await topic.refresh();
      throw new Error(switchRefusal(error));
    }
    setConfirming("");
    await topic.refresh();
  };
  return (
    <section id={semanticMemorySection} aria-labelledby={id}>
      <GroupLabel id={id}>{copy.title}</GroupLabel>
      <ListCard labelledBy={id}>
        <ListRow
          label={copy.label}
          sub={copy.description(size)}
          status={{ tone: view.tone, text: view.state }}
        />
        {view.running && (
          <div className="agent-row-note" role="status">
            <p>{view.progress}</p>
          </div>
        )}
        {view.note && (
          <div className="agent-row-note">
            <p>{view.note}</p>
          </div>
        )}
        {view.alert && (
          <p role="alert" className="assistant-notice">
            {view.alert}
          </p>
        )}
        {view.actions.map((action) => (
          <ListRow
            key={action.kind}
            label={action.label}
            sub={view.running ? copy.running : action.hint}
            disabled={action.disabled}
            onClick={() => setConfirming(action.kind)}
          />
        ))}
      </ListCard>
      {confirming === "repair" && (
        <ConfirmDialog
          title={copy.repairTitle}
          body={[copy.repairBody(size), copy.onBodyFailure]}
          confirmLabel={copy.repairConfirm}
          focusCancel
          onCancel={() => setConfirming("")}
          onConfirm={() => apply(true, true)}
        />
      )}
      {confirming === "on" && (
        <ConfirmDialog
          title={copy.onTitle}
          body={[copy.onBody(size), copy.onBodyFailure]}
          confirmLabel={copy.onConfirm}
          focusCancel
          onCancel={() => setConfirming("")}
          onConfirm={() => apply(true)}
        >
          <p className="agent-terms-note">
            {copy.terms}{" "}
            <a href={status.model?.termsUrl} target="_blank" rel="noopener noreferrer">
              {copy.termsLink}
            </a>
            .
          </p>
        </ConfirmDialog>
      )}
      {confirming === "off" && (
        <ConfirmDialog
          title={copy.offTitle}
          body={[copy.offBody, copy.offBodyModel]}
          confirmLabel={copy.offConfirm}
          focusCancel
          onCancel={() => setConfirming("")}
          onConfirm={() => apply(false)}
        />
      )}
    </section>
  );
}
