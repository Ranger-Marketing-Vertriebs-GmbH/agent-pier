import React, { useId, useState } from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import api from "../../lib/api.js";
import { browserUuid } from "../../lib/browser-uuid.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { autopilotActionsCopy as copy } from "../../lib/i18n/messages/autopilot-actions.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { launchDialogCopy } from "../../lib/i18n/messages/sessions.js";
import { rememberLaunchMode } from "../sessions/launch-modes.js";
import { rememberLaunchChoice } from "../sessions/launch-preferences.js";
import OrderPermissions from "./OrderPermissions.jsx";
import OrderSessionFields, { useOrderSession } from "./OrderSessionFields.jsx";
import "./order-actions.css";

export default function NewOrder({ state, onCreated, onCancel, onOpenOrder }) {
  const projects = useLiveTopic("projects.changed", "/autopilot/projects");
  const session = useOrderSession(state);
  // A timeout can follow a successful reservation. Keep the key across every
  // submission of this form, including retries after a lost launch response.
  const [requestId] = useState(browserUuid);
  const [reserved, setReserved] = useState(null);
  const [selected, setSelected] = useState("");
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [policy, setPolicy] = useState({
    implementationAuthorized: false,
    allowMerge: false,
  });
  const mutation = useAsyncAction();
  const formId = useId();
  const available = projects.data?.projects || [];
  const projectId = selected || (available.length === 1 ? available[0].id : "");
  const ready =
    available.some((project) => project.id === projectId) && session.access.ready;
  const close = () => {
    if (!mutation.lock.current) onCancel();
  };
  async function submit(event) {
    event.preventDefault();
    await mutation.run(async () => {
      if (!ready || reserved) return;
      if (new TextEncoder().encode(brief.trim()).length > 65536)
        throw Error(copy.briefLimit);
      let order;
      try {
        order = await api("/autopilot/orders", "POST", {
          projectId,
          requestId,
          title: title.trim(),
          brief: brief.trim(),
          session: session.body,
          ...policy,
        });
      } catch (error) {
        if (error.orderId) setReserved(error.orderId);
        throw error;
      }
      const { tool, accessId, accessPicked, modelId } = session.access;
      rememberLaunchChoice(tool, accessId, { picked: accessPicked, modelId });
      rememberLaunchMode(tool, session.mode);
      await onCreated(order);
    });
  }
  return (
    <Modal
      title={copy.newOrder}
      close={close}
      closeDisabled={mutation.busy}
      className="autopilot-new-order"
      footer={
        <>
          <button
            type="button"
            className="button secondary"
            disabled={mutation.busy}
            onClick={close}
          >
            {commonCopy.cancel}
          </button>
          {reserved ? (
            <button
              type="button"
              className="button primary"
              onClick={() => onOpenOrder(reserved)}
            >
              {copy.openReserved}
            </button>
          ) : (
            <button
              type="submit"
              form={formId}
              className="button primary"
              disabled={!ready || mutation.busy || !title.trim() || !brief.trim()}
            >
              {mutation.busy ? commonCopy.pending : copy.openComposer}
            </button>
          )}
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="autopilot-new-form">
        <fieldset
          disabled={mutation.busy || !!reserved}
          className="autopilot-order-fields"
        >
          <label>
            {copy.project}
            <AnchoredSelect
              label={copy.project}
              value={projectId}
              onChange={setSelected}
              required
              disabled={!available.length}
              options={[
                { value: "", label: copy.chooseProject, disabled: true },
                ...available.map((project) => ({
                  value: project.id,
                  label: available.some(
                    (other) => other.id !== project.id && other.name === project.name,
                  )
                    ? project.cwd
                    : project.name || project.cwd,
                })),
              ]}
            />
          </label>
          <ErrorMessage error={projects.error} />
          {projects.error && (
            <button className="button secondary" type="button" onClick={projects.refresh}>
              {commonCopy.retry}
            </button>
          )}
          {!projects.error && !projects.loading && !available.length && (
            <p className="field-description">{copy.noProjects}</p>
          )}
          <label>
            {copy.title}
            <input
              value={title}
              required
              maxLength={100}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            {copy.brief}
            <textarea
              value={brief}
              rows={6}
              required
              onChange={(event) => setBrief(event.target.value)}
            />
          </label>
          <OrderPermissions
            policy={policy}
            change={(key, value) => setPolicy({ ...policy, [key]: value })}
          />
        </fieldset>
        <fieldset
          disabled={mutation.busy || !!reserved}
          className="autopilot-order-fields"
        >
          <legend>{launchDialogCopy.sessionSection}</legend>
          <OrderSessionFields session={session} />
        </fieldset>
      </form>
      <ErrorMessage error={mutation.error} />
    </Modal>
  );
}
