import React, { useMemo, useRef, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ListCard from "../../components/ListCard.jsx";
import { SelectRow } from "../../components/ListRow.jsx";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import AccountDetail, { AccountSaveBar } from "../accounts/AccountDetail.jsx";
import FieldRow from "../accounts/FieldRow.jsx";
import UsedByGroup from "../accounts/UsedByGroup.jsx";
import useAccountDraft from "../accounts/useAccountDraft.js";
import { accountItemTitle } from "../accounts/accounts-items.js";
import { assistantApi } from "./assistant-api.js";

const serverOf = (settings) => ({
  apiKey: "",
  model: settings?.model ?? "",
  language: settings?.language ?? "auto",
});

/** The central Deepgram connection for agent voice messages. */
export default function SpeechSettings({ entry, usage, agentsEnabled, data, navigate }) {
  const copy = assistantCopy.speech;
  const settings = data.speech;
  const formRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { reloadSpeech } = data;
  const server = useMemo(
    () => serverOf(settings),
    [settings?.model, settings?.language], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const form = useAccountDraft({
    server,
    revisions: settings ? { speech: settings.revision } : {},
    refresh: async () => {
      const next = await reloadSpeech();
      return next && { server: serverOf(next), revisions: { speech: next.revision } };
    },
    tab: accountItemTitle(entry),
    entry,
    steps: [
      {
        id: "speech",
        label: copy.save,
        resource: "speech",
        async run({ values, revision }) {
          const next = await assistantApi.saveSpeech({
            revision,
            model: values.model,
            language: values.language,
            ...(values.apiKey ? { apiKey: values.apiKey } : {}),
          });
          data.setSpeech(next);
          return next;
        },
      },
    ],
  });
  const { draft } = form;
  async function removeKey() {
    setBusy(true);
    setError("");
    try {
      data.setSpeech(
        await assistantApi.saveSpeech({
          revision: settings.revision,
          model: settings.model,
          language: settings.language,
          removeApiKey: true,
        }),
      );
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <AccountDetail
      title={accountItemTitle(entry)}
      destructive={
        settings?.hasSecret && (
          <button
            type="button"
            className="button secondary danger-text"
            // Removing saves at once: unsaved changes would turn into a conflict.
            disabled={busy || draft.dirty || draft.saving}
            onClick={removeKey}
          >
            {copy.remove}
          </button>
        )
      }
      bar={<AccountSaveBar form={form} formRef={formRef} saveLabel={copy.save} />}
    >
      <p className="accounts-note">{copy.description}</p>
      <ErrorMessage error={error || data.speechError} />
      {settings && (
        <form
          ref={formRef}
          className="accounts-detail-group"
          onSubmit={(event) => {
            event.preventDefault();
            form.save();
          }}
        >
          <p className="accounts-note" role="status">
            {settings.hasSecret ? copy.saved : copy.missing}
          </p>
          <ListCard>
            <FieldRow label={copy.key}>
              <input
                type="password"
                autoComplete="new-password"
                maxLength={1024}
                value={draft.values.apiKey}
                onChange={(event) => draft.set("apiKey", event.target.value)}
              />
            </FieldRow>
            <FieldRow label={copy.model}>
              <input
                required
                value={draft.values.model}
                onChange={(event) => draft.set("model", event.target.value)}
              />
            </FieldRow>
            <SelectRow
              label={copy.language}
              value={draft.values.language}
              onChange={(value) => draft.set("language", value)}
              options={[
                { value: "auto", label: copy.auto },
                { value: "de", label: copy.german },
                { value: "en", label: copy.english },
              ]}
            />
          </ListCard>
        </form>
      )}
      <UsedByGroup usage={usage} agentsEnabled={agentsEnabled} navigate={navigate} />
    </AccountDetail>
  );
}
