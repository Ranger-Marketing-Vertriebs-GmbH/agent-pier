import React, { useState } from "react";
import AsyncForm from "../../components/AsyncForm.jsx";
import Modal from "../../components/Modal.jsx";
import api from "../../lib/api.js";
import { ticketSequenceStartCopy as copy } from "../../lib/i18n/messages/ticket-sequences.js";
import { ticketStartCopy } from "../../lib/i18n/messages/tickets.js";
import SequenceOptionsFields, { useSequenceOptions } from "./SequenceOptionsFields.jsx";
import { startRefusal } from "./ticket-list.js";
import { queueItemPath } from "./ticket-queue.js";
import "./project-tickets.css";

/**
 * Starts the selected tickets (in list order) as one sequence of `projectId`: each as
 * a session or a pipeline run, with the repair session of a pipeline sequence
 * (prefilled from `defaults.repair`) and "Allow merge", off by default. A ticket that
 * was started before is refused once; the button then starts the sequence again.
 */
export default function SequenceStartDialog({
  projectId,
  tickets,
  state,
  defaults,
  close,
  onStarted,
}) {
  const { ready, options, fieldProps } = useSequenceOptions({ state, defaults });
  const [again, setAgain] = useState(false);
  return (
    <Modal title={copy.title(tickets.length)} close={close}>
      <AsyncForm
        close={close}
        button={again ? ticketStartCopy.again : copy.start}
        disabled={!ready}
        submit={async () => {
          const body = {
            tickets: tickets.map(({ source, key }) => ({ source, key })),
            ...options,
            again,
          };
          const view = await api(queueItemPath(projectId), "POST", body).catch(
            (error) => {
              // Started before: the next submit starts the sequence again.
              if (startRefusal(error) === "started") setAgain(true);
              throw error;
            },
          );
          await onStarted(view);
        }}
      >
        <p className="field-description">
          {copy.order(tickets.map((ticket) => ticket.key).join(", "))}
        </p>
        <SequenceOptionsFields {...fieldProps} />
      </AsyncForm>
    </Modal>
  );
}
