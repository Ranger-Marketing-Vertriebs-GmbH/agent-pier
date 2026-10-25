import React, { useMemo, useRef, useState } from "react";
import PendingRestartNotice from "./PendingRestartNotice.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import { assistantPdfCopy as copy } from "../../lib/i18n/messages/assistant-pdf.js";
import { runSaveChain } from "../../lib/settings/save-chain.js";
import AccountDetail, { AccountSaveBar } from "../accounts/AccountDetail.jsx";
import UsedByGroup from "../accounts/UsedByGroup.jsx";
import useAccountDraft from "../accounts/useAccountDraft.js";
import { accountItemTitle } from "../accounts/accounts-items.js";
import { restartNote } from "../accounts/account-usage-view.js";
import AssistantModelFields from "./AssistantModelFields.jsx";
import { assistantApi } from "./assistant-api.js";
import RestartConfirmation from "./RestartConfirmation.jsx";
import useAssistants from "./useAssistants.js";

const serverOf = (settings) => ({
  connectionId: settings?.connectionId || "",
  modelId: settings?.modelId || "",
});

/**
 * The optional PDF fallback model, for agents whose own model does not accept images,
 * chosen from the agents' model connections. Only ids are saved; the connection keeps
 * its key.
 */
export default function PdfModelSettings({
  entry,
  usage,
  agentsEnabled,
  data,
  navigate,
}) {
  const settings = data.pdfModel;
  const { models } = useAssistants();
  const formRef = useRef(null);
  const [removal, setRemoval] = useState(null);
  const [error, setError] = useState("");
  const { reloadPdfModel } = data;
  const server = useMemo(
    () => serverOf(settings),
    [settings?.connectionId, settings?.modelId], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const form = useAccountDraft({
    server,
    revisions: settings ? { pdfModel: settings.revision } : {},
    refresh: async () => {
      const next = await reloadPdfModel();
      return next && { server: serverOf(next), revisions: { pdfModel: next.revision } };
    },
    tab: accountItemTitle(entry),
    entry,
    steps: [
      {
        id: "pdf-model",
        label: copy.save,
        resource: "pdfModel",
        async run({ values, revision, confirmations }) {
          const next = await assistantApi.savePdfModel({
            revision,
            connectionId: values.connectionId,
            modelId: values.modelId,
            ...confirmations,
          });
          data.setPdfModel(next);
          return next;
        },
      },
    ],
  });
  const { draft } = form;
  const values = draft.values;
  // Any change withdraws an open restart question; it was about the previous state.
  const edit = (key, value) => {
    draft.confirmation?.cancel();
    draft.set(key, value);
  };
  async function remove() {
    setError("");
    const result = await runSaveChain({
      steps: [
        {
          id: "remove-model",
          label: copy.remove,
          run: ({ confirmations }) =>
            assistantApi.savePdfModel({
              revision: settings.revision,
              connectionId: null,
              modelId: null,
              ...confirmations,
            }),
        },
      ],
      values: {},
      base: {},
      ask: (request) =>
        new Promise((resolve) =>
          setRemoval({
            ...request,
            confirm: () => {
              setRemoval(null);
              resolve(true);
            },
            cancel: () => {
              setRemoval(null);
              resolve(false);
            },
          }),
        ),
    });
    if (result.status === "saved") data.setPdfModel(result.results["remove-model"]);
    else if (result.error) setError(result.error.message);
  }
  const restart = draft.confirmation?.kind === "restart" ? draft.confirmation : removal;
  return (
    <AccountDetail
      title={accountItemTitle(entry)}
      destructive={
        settings?.connectionId && (
          <button
            type="button"
            className="button secondary danger-text"
            // Removing saves at once: unsaved changes would turn into a conflict.
            disabled={draft.saving || draft.dirty || Boolean(removal)}
            onClick={remove}
          >
            {copy.remove}
          </button>
        )
      }
      bar={
        <AccountSaveBar
          form={form}
          formRef={formRef}
          saveLabel={copy.save}
          note={restartNote(usage)}
        />
      }
    >
      <ErrorMessage error={error || data.pdfModelError} />
      <PendingRestartNotice />
      {settings && (
        <form
          ref={formRef}
          className="accounts-detail-group"
          onSubmit={(event) => {
            event.preventDefault();
            form.save();
          }}
        >
          <p className="accounts-note">{copy.intro}</p>
          <p className="accounts-note" role="status">
            {settings.ready ? copy.ready : copy.status[settings.reason]}
          </p>
          {settings.images === false && (
            <p className="accounts-note" role="note">
              {copy.textOnly}
            </p>
          )}
          <GroupLabel hint={copy.hint}>{copy.model}</GroupLabel>
          {models.some((model) => model.available) ? (
            <div className="list-card agent-fields">
              <div className="agent-field">
                <AssistantModelFields
                  models={models}
                  connectionId={values.connectionId}
                  modelId={values.modelId}
                  setConnection={(value) => edit("connectionId", value)}
                  setModel={(value) => edit("modelId", value)}
                />
              </div>
            </div>
          ) : (
            <p className="accounts-note">{copy.noConnections}</p>
          )}
        </form>
      )}
      {restart && (
        <RestartConfirmation
          affected={restart.data?.affected}
          busy={false}
          onConfirm={restart.confirm}
          onCancel={restart.cancel}
        />
      )}
      <UsedByGroup usage={usage} agentsEnabled={agentsEnabled} navigate={navigate} />
    </AccountDetail>
  );
}
