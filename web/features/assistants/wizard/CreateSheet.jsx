import React, { useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import SidePanel from "../../../components/SidePanel.jsx";
import useResource from "../../../lib/useResource.js";
import { agentWizardCopy } from "../../../lib/i18n/messages/agent-wizard.js";
import { commonCopy } from "../../../lib/i18n/messages/common.js";
import { memoryCopy } from "../../../lib/i18n/messages/memory.js";
import { secretsCopy } from "../../../lib/i18n/messages/secrets.js";
import { sshCopy } from "../../../lib/i18n/messages/ssh.js";
import AddFolderDialog from "../../projects/AddFolderDialog.jsx";
import CredentialDialog from "../../repositories/CredentialDialog.jsx";
import SecretForm from "../../secrets/SecretForm.jsx";
import SshAccessForm from "../../ssh/SshAccessForm.jsx";
import SshKeyForm from "../../ssh/SshKeyForm.jsx";
import "../../projects/project-dialogs.css";
import "../../secrets/secrets.css";
import "../../repositories/repositories.css";
import "../../ssh/ssh.css";
import "../../ssh/ssh-settings.css";

// A source still loading, or why it did not load.
const pending = (...resources) => {
  const error = resources.map((resource) => resource.error).find(Boolean);
  return error ? (
    <ErrorMessage error={error} />
  ) : (
    <p role="status">{agentWizardCopy.access.loading}</p>
  );
};

/**
 * SSH/SFTP: the access form of Zugänge; without any key it starts with the key form
 * (an SFTP access with a password needs none, so the access form stays reachable).
 */
function SshCreate({ created }) {
  const keys = useResource("/ssh-keys");
  const projects = useResource("/ssh-projects");
  const [keyForm, setKeyForm] = useState(null);
  const list = keys.data?.keys;
  const owners = projects.data?.projects;
  if (!list || !owners) return pending(keys, projects);
  const addingKey = keyForm ?? list.length === 0;
  if (addingKey)
    return (
      <>
        {list.length === 0 && (
          <p className="field-description">{agentWizardCopy.access.noKey}</p>
        )}
        <SshKeyForm
          bare
          projects={owners}
          saved={(key) => {
            keys.update({ keys: [...list, key] });
            setKeyForm(false);
          }}
        />
        {list.length === 0 && (
          <button
            type="button"
            className="button secondary compact"
            onClick={() => setKeyForm(false)}
          >
            {agentWizardCopy.access.withoutKey}
          </button>
        )}
      </>
    );
  return (
    <>
      <SshAccessForm bare keys={list} projects={owners} saved={created} />
      <button
        type="button"
        className="button secondary compact"
        onClick={() => setKeyForm(true)}
      >
        {sshCopy.addKey}
      </button>
    </>
  );
}

function SecretCreate({ created }) {
  const projects = useResource("/ssh-projects");
  if (!projects.data) return pending(projects);
  return <SecretForm secret={null} projects={projects.data.projects} saved={created} />;
}

function GithubCreate({ created, close }) {
  const repositories = useResource("/repositories");
  if (!repositories.data) return pending(repositories);
  return (
    <CredentialDialog
      bare
      credentials={repositories.data.credentials || []}
      close={close}
      saved={(credential) => credential && created(credential)}
    />
  );
}

// The forms, their titles, and what each hands back when it saved.
const kinds = {
  ssh: [() => sshCopy.add, SshCreate],
  secrets: [() => secretsCopy.add, SecretCreate],
  github: [() => commonCopy.addToken, GithubCreate],
  projects: [
    () => memoryCopy.addProject,
    ({ created }) => <AddFolderDialog bare added={created} />,
  ],
};
export const createKinds = Object.keys(kinds);

/**
 * "+ … anlegen" (handoff 5.3 step 4): the creation form of Zugänge (SSH/SFTP access and
 * key, secret, GitHub token profile) or of Projekte in a side sheet over the wizard.
 * The draft stays; `onCreated(item)` hears the new record, which the step reads into
 * its list and selects. Cancel closes without creating anything.
 */
export default function CreateSheet({ kind, onCreated, onClose }) {
  const [title, Form] = kinds[kind];
  return (
    <SidePanel
      title={title()}
      subtitle={agentWizardCopy.connect.subtitle}
      close={onClose}
    >
      <div className="agent-wizard-sheet">
        <Form created={(item) => onCreated(item)} close={onClose} />
      </div>
    </SidePanel>
  );
}
