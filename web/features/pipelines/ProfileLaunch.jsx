import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import React, { useState } from "react";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
export default function ProfileLaunch({ profile, home, close, started }) {
  const [cwd, setCwd] = useState(home || ""),
    [params, setParams] = useState({}),
    [model, setModel] = useState(profile.config.models.default);
  const action = useAsyncAction();
  return (
    <Modal
      title={copy.startProfile}
      close={() => {
        if (!action.lock.current) close();
      }}
      closeDisabled={action.busy}
    >
      <form
        className="pipeline-form"
        onSubmit={(event) => {
          event.preventDefault();
          action.run(async () => {
            const result = await api(`/pipeline-profiles/${profile.id}/launch`, "POST", {
              cwd,
              params,
              model,
            });
            await started(result.session || result);
            close();
          });
        }}
      >
        <label>
          {copy.directory}
          <input required value={cwd} onChange={(event) => setCwd(event.target.value)} />
        </label>
        <label>
          {copy.model}
          <AnchoredSelect
            label={copy.model}
            value={model}
            disabled={action.busy}
            onChange={setModel}
            options={[...new Set(profile.config.models.available)].map((value) => ({
              value,
              label: value || copy.accountDefault,
            }))}
          />
        </label>
        {profile.config.prompts.params.map((param) => (
          <label key={param.key}>
            {param.label}
            <input
              required={param.required}
              value={params[param.key] || ""}
              onChange={(event) =>
                setParams({ ...params, [param.key]: event.target.value })
              }
            />
          </label>
        ))}
        <ErrorMessage error={action.error} />
        <button className="button primary" disabled={action.busy}>
          {copy.startProfile}
        </button>
      </form>
    </Modal>
  );
}
