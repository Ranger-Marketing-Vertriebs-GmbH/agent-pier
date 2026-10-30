import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ListCard from "../../components/ListCard.jsx";
import { SelectRow, ToggleRow } from "../../components/ListRow.jsx";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import AccountDetail, { AccountSaveBar } from "../accounts/AccountDetail.jsx";
import FieldRow from "../accounts/FieldRow.jsx";
import UsedByGroup from "../accounts/UsedByGroup.jsx";
import useAccountDraft from "../accounts/useAccountDraft.js";
import { accountItemTitle } from "../accounts/accounts-items.js";
import { runSaveChain } from "../../lib/settings/save-chain.js";
import { assistantApi } from "./assistant-api.js";
import RestartConfirmation from "./RestartConfirmation.jsx";
import VoiceFields, { voiceInput, voiceKeys, voiceServerOf } from "./VoiceFields.jsx";
import { talkCopy } from "../../lib/i18n/messages/talk.js";

const serverOf = (settings) => ({
  apiKey: "",
  model: settings?.model ?? "",
  language: settings?.language ?? "auto",
  dictationSend: settings?.dictationSend === true,
});

const speechKeys = ["apiKey", "model", "language", "dictationSend"];

/**
 * The central Deepgram connection for agent voice messages and dictation, and the
 * voice that reads replies aloud in talk mode (VoiceFields.jsx): one draft, two steps.
 */
export default function SpeechSettings({ entry, usage, agentsEnabled, data, navigate }) {
  const copy = assistantCopy.speech;
  const settings = data.speech;
  const formRef = useRef(null);
  const [error, setError] = useState("");
  // The restart question of a key removal (outside the draft's own chain).
  const [removal, setRemoval] = useState(null);
  const { reloadSpeech } = data;
  const [voice, setVoice] = useState(null);
  const reloadVoice = useCallback(async () => {
    const next = await assistantApi.voice();
    setVoice(next);
    return next;
  }, []);
  useEffect(() => {
    reloadVoice().catch((e) => setError(e.message));
  }, [reloadVoice]);
  const server = useMemo(
    () => ({ ...serverOf(settings), ...voiceServerOf(voice) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      settings?.model,
      settings?.language,
      settings?.dictationSend,
      voice?.provider,
      voice?.openaiVoice,
      voice?.elevenlabsVoice,
    ],
  );
  const form = useAccountDraft({
    server,
    revisions: settings
      ? { speech: settings.revision, ...(voice ? { voice: voice.revision } : {}) }
      : {},
    refresh: async () => {
      const [next, nextVoice] = await Promise.all([reloadSpeech(), reloadVoice()]);
      return (
        next && {
          server: { ...serverOf(next), ...voiceServerOf(nextVoice) },
          revisions: { speech: next.revision, voice: nextVoice.revision },
        }
      );
    },
    tab: accountItemTitle(entry),
    entry,
    steps: [
      {
        id: "speech",
        label: copy.save,
        resource: "speech",
        keys: speechKeys,
        // Agents' own Telegram bots run with the key: the server asks to restart.
        async run({ values, revision, confirmations }) {
          const next = await assistantApi.saveSpeech({
            revision,
            model: values.model,
            language: values.language,
            dictationSend: values.dictationSend,
            ...(values.apiKey ? { apiKey: values.apiKey } : {}),
            ...confirmations,
          });
          data.setSpeech(next);
          return next;
        },
      },
      {
        id: "voice",
        label: talkCopy.voice.save,
        resource: "voice",
        keys: voiceKeys,
        async run({ values, revision }) {
          const next = await assistantApi.saveVoice(voiceInput(values, revision));
          setVoice(next);
          return next;
        },
      },
    ],
  });
  const { draft } = form;
  // Any change withdraws an open restart question; it was about the previous state.
  const edit = (key, value) => {
    draft.confirmation?.cancel();
    draft.set(key, value);
  };
  async function removeKey() {
    setError("");
    const result = await runSaveChain({
      steps: [
        {
          id: "remove-key",
          label: copy.remove,
          run: ({ confirmations }) =>
            assistantApi.saveSpeech({
              revision: settings.revision,
              model: settings.model,
              language: settings.language,
              removeApiKey: true,
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
    if (result.status === "saved") data.setSpeech(result.results["remove-key"]);
    else if (result.error) setError(result.error.message);
  }
  const restart = draft.confirmation?.kind === "restart" ? draft.confirmation : removal;
  return (
    <AccountDetail
      title={accountItemTitle(entry)}
      destructive={
        settings?.hasSecret && (
          <button
            type="button"
            className="button secondary danger-text"
            // Removing saves at once: unsaved changes would turn into a conflict.
            disabled={draft.saving || draft.dirty || Boolean(removal)}
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
                onChange={(event) => edit("apiKey", event.target.value)}
              />
            </FieldRow>
            <FieldRow label={copy.model}>
              <input
                required
                value={draft.values.model}
                onChange={(event) => edit("model", event.target.value)}
              />
            </FieldRow>
            <SelectRow
              label={copy.language}
              value={draft.values.language}
              onChange={(value) => edit("language", value)}
              options={[
                { value: "auto", label: copy.auto },
                { value: "de", label: copy.german },
                { value: "en", label: copy.english },
              ]}
            />
          </ListCard>
          <ListCard>
            <ToggleRow
              label={copy.dictationSend}
              sub={copy.dictationSendHint}
              checked={draft.values.dictationSend}
              onChange={(value) => edit("dictationSend", value)}
            />
          </ListCard>
          {voice && <VoiceFields voice={voice} values={draft.values} edit={edit} />}
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
