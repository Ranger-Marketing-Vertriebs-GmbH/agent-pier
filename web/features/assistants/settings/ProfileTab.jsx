import React, { useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import SaveBar from "../../../components/SaveBar.jsx";
import UnsavedChangesSheet from "../../../components/UnsavedChangesSheet.jsx";
import useTabDraft from "../../../lib/settings/useTabDraft.js";
import { assistantCopy as copy } from "../../../lib/i18n/messages/assistants.js";
import { assistantSettingsCopy as settingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import useAssistants from "../useAssistants.js";
import { assistantApi } from "../assistant-api.js";
import { followsLeadModel, profileServer } from "./agent-settings-fields.js";
import { profileStep } from "./agent-settings-steps.js";
import useAgentDraftGuard from "./useAgentDraftGuard.js";
import ConflictNotice from "./ConflictNotice.jsx";
import ConfirmationSheet from "./ConfirmationSheet.jsx";
import ProfileFields, { profileValid } from "./ProfileFields.jsx";
import MemberGroup from "./MemberGroup.jsx";
import AttachmentStorageGroup from "./AttachmentStorageGroup.jsx";
import RuntimeSummary from "./RuntimeSummary.jsx";
import TemplateNote from "./TemplateNote.jsx";
import UserAccessGroup from "./UserAccessGroup.jsx";

const conflictLabels = {
  name: () => copy.name,
  instructions: () => copy.instructions,
  connectionId: () => copy.connection,
  modelId: () => copy.model,
};

/** Profile: name, instructions, model; team member card; one PATCH per save. */
export default function ProfileTab({ assistant, navigate }) {
  const { models, refresh, runtime } = useAssistants();
  const draft = useTabDraft({
    server: profileServer(assistant),
    revisions: { assistant: assistant.revision },
  });
  const label = settingsCopy.tabs.profile;
  const followsLead = followsLeadModel(assistant);
  const steps = [profileStep({ assistantId: assistant.id, label, followsLead })];
  const after = async (result) => {
    if (result.status === "saved") await refresh();
    return result;
  };
  // The browser checks the fields (a name is required) before anything is sent.
  const save = async () =>
    profileValid(draft) ? after(await draft.save(steps)) : { status: "invalid" };
  const overwrite = async () => after(await draft.overwrite(steps));
  const sheet = useAgentDraftGuard({
    draft,
    assistantId: assistant.id,
    tab: "profile",
    label,
    save,
  });
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function confirmInstructions() {
    setBusy(true);
    setError("");
    try {
      await assistantApi.update(assistant.id, {
        confirmInstructions: true,
        revision: assistant.revision,
      });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <form
        id="agent-profile"
        className="agent-settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.dirty) save();
        }}
      >
        <ErrorMessage error={error} />
        <ConflictNotice draft={draft} labels={conflictLabels} />
        {assistant.instructionsSource === "model" && (
          <p className="assistant-note agent-review-strip" role="note">
            {copy.generatedInstructions}{" "}
            <button
              type="button"
              className="button secondary"
              disabled={busy || draft.dirty}
              onClick={confirmInstructions}
            >
              {copy.confirmInstructions}
            </button>
          </p>
        )}
        {/* The Agency template its instructions came from (source and license). */}
        {assistant.template && (
          <TemplateNote template={assistant.template} scan={false} />
        )}
        <ProfileFields
          draft={draft}
          models={models}
          modelKey={assistant.id}
          navigate={navigate}
          followsLead={followsLead}
        />
        <p className="agent-revision">
          {copy.revisions(assistant.revision, assistant.effectiveRevision)}
          <br />
          {copy.pendingConfig}
        </p>
      </form>
      {assistant.teamMemberId && <MemberGroup assistant={assistant} />}
      <UserAccessGroup assistant={assistant} />
      <AttachmentStorageGroup assistant={assistant} />
      <RuntimeSummary
        className="agent-runtime-group"
        runtime={runtime}
        navigate={navigate}
      />
      <SaveBar
        draft={draft}
        onSave={save}
        onOverwrite={overwrite}
        saveLabel={copy.save}
        note={copy.pendingConfigShort}
      />
      <ConfirmationSheet confirmation={draft.confirmation} />
      <UnsavedChangesSheet {...sheet} />
    </>
  );
}
