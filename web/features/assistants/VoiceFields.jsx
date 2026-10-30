import React from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import { CheckboxRow, SelectRow } from "../../components/ListRow.jsx";
import { talkCopy } from "../../lib/i18n/messages/talk.js";
import FieldRow from "../accounts/FieldRow.jsx";

// The voices of OpenAI's gpt-4o-mini-tts (server/features/speech/voice-connections.js).
export const openaiVoices = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
];

/** The draft values of the voice settings (GET /api/assistant-speech/voice). */
export const voiceServerOf = (voice) => ({
  voiceProvider: voice?.provider ?? "openai",
  openaiVoice: voice?.openaiVoice ?? "coral",
  elevenlabsVoice: voice?.elevenlabsVoice ?? "",
  openaiApiKey: "",
  elevenlabsApiKey: "",
  removeOpenaiApiKey: false,
  removeElevenlabsApiKey: false,
});
export const voiceKeys = Object.keys(voiceServerOf(null));

/** The PUT body for the voice settings from the draft: keys only when typed. */
export function voiceInput(values, revision) {
  return {
    revision,
    provider: values.voiceProvider,
    openaiVoice: values.openaiVoice,
    elevenlabsVoice: values.elevenlabsVoice,
    ...(values.openaiApiKey ? { openaiApiKey: values.openaiApiKey } : {}),
    ...(values.elevenlabsApiKey ? { elevenlabsApiKey: values.elevenlabsApiKey } : {}),
    ...(values.removeOpenaiApiKey && !values.openaiApiKey
      ? { removeOpenaiApiKey: true }
      : {}),
    ...(values.removeElevenlabsApiKey && !values.elevenlabsApiKey
      ? { removeElevenlabsApiKey: true }
      : {}),
  };
}

/**
 * The voice for talk mode in the speech settings: provider, its key and its voice.
 * A stored key is never shown; the field replaces it and a checkbox removes it.
 */
export default function VoiceFields({ voice, values, edit }) {
  const copy = talkCopy.voice;
  const openai = values.voiceProvider === "openai";
  const stored = openai ? voice?.hasOpenaiKey : voice?.hasElevenlabsKey;
  const keyField = openai ? "openaiApiKey" : "elevenlabsApiKey";
  const removeField = openai ? "removeOpenaiApiKey" : "removeElevenlabsApiKey";
  return (
    <>
      <GroupLabel id="voice-settings">{copy.title}</GroupLabel>
      <p className="accounts-note">{copy.description}</p>
      <p className="accounts-note">{copy.chatgptNote}</p>
      <ListCard labelledBy="voice-settings">
        <SelectRow
          label={copy.provider}
          value={values.voiceProvider}
          onChange={(value) => edit("voiceProvider", value)}
          options={[
            { value: "openai", label: copy.openai },
            { value: "elevenlabs", label: copy.elevenlabs },
          ]}
        />
        <FieldRow
          label={openai ? copy.openaiKey : copy.elevenlabsKey}
          help={stored ? copy.keySaved : copy.keyMissing}
        >
          <input
            type="password"
            autoComplete="new-password"
            maxLength={1024}
            value={values[keyField]}
            onChange={(event) => edit(keyField, event.target.value)}
          />
        </FieldRow>
        {stored && (
          <CheckboxRow
            label={copy.removeKey}
            checked={values[removeField]}
            onChange={(value) => edit(removeField, value)}
          />
        )}
        {openai ? (
          <SelectRow
            label={copy.openaiVoice}
            value={values.openaiVoice}
            onChange={(value) => edit("openaiVoice", value)}
            options={openaiVoices.map((name) => ({ value: name, label: name }))}
          />
        ) : (
          <FieldRow label={copy.elevenlabsVoice} help={copy.elevenlabsVoiceHelp}>
            <input
              required
              pattern="[A-Za-z0-9]{8,64}"
              value={values.elevenlabsVoice}
              onChange={(event) => edit("elevenlabsVoice", event.target.value)}
            />
          </FieldRow>
        )}
      </ListCard>
    </>
  );
}
