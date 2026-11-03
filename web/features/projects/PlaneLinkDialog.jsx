import React, { useState } from "react";
import AnchoredSelect from "../../components/AnchoredSelect.jsx";
import AsyncForm from "../../components/AsyncForm.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Modal from "../../components/Modal.jsx";
import ReferenceRow from "../../components/ReferenceRow.jsx";
import api from "../../lib/api.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import {
  planeConnectionsCopy,
  projectTicketsCopy as copy,
} from "../../lib/i18n/messages/tickets.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import useResource from "../../lib/useResource.js";
import { connectionsRoute, connectionsRoutePath } from "../connections/routes.js";

const enc = encodeURIComponent;

/**
 * Edits a project's ticket sources: the linked Plane project (connection, project and,
 * when Plane has several, the "In progress" state) and the GitHub label for started
 * issues. Plane's identifier and name are looked up by the server. Disconnect unlinks
 * the Plane project; a source left out of a save keeps its link.
 */
export default function PlaneLinkDialog({ projectId, view, onNavigate, close }) {
  const plane = view?.sources?.plane || {};
  const github = view?.sources?.github || {};
  const live = useLiveTopic("tickets.connections", "/ticket-connections");
  const connections = live.data?.connections || [];
  const [connectionId, setConnectionId] = useState(plane.connectionId || "");
  const [planeProjectId, setPlaneProjectId] = useState(plane.planeProjectId || "");
  const [stateId, setStateId] = useState(plane.inProgressStateId || "");
  const [label, setLabel] = useState(github.inProgressLabel || "");
  const projects = useResource(
    connectionId ? `/ticket-connections/${enc(connectionId)}/projects` : null,
  );
  const states = useResource(
    connectionId && planeProjectId
      ? `/ticket-connections/${enc(connectionId)}/projects/${enc(planeProjectId)}/states`
      : null,
  );
  const started = (states.data?.states || []).filter((item) => item.group === "started");
  const disconnect = useAsyncAction();
  const [saving, setSaving] = useState(false);
  const path = `/tickets/projects/${enc(projectId)}/sources`;
  const connectionsLink = connectionsRoute("tickets");
  return (
    <Modal title={copy.editTitle} close={close} dismissOnBackdrop={false}>
      <AsyncForm
        close={close}
        button={commonCopy.save}
        disabled={disconnect.busy}
        submit={async () => {
          const body = { github: { inProgressLabel: label.trim() } };
          if (connectionId && planeProjectId)
            body.plane = {
              connectionId,
              planeProjectId,
              inProgressStateId:
                started.length > 1 && started.some((item) => item.id === stateId)
                  ? stateId
                  : null,
            };
          setSaving(true);
          try {
            await api(path, "PUT", body);
          } finally {
            setSaving(false);
          }
          close();
        }}
      >
        {live.data && !connections.length ? (
          <>
            <p className="field-description">{copy.noConnections}</p>
            <ReferenceRow
              title={planeConnectionsCopy.title}
              sub={copy.planeReferenceSub}
              href={connectionsRoutePath(connectionsLink)}
              onOpen={() => {
                close();
                onNavigate(connectionsLink);
              }}
            />
          </>
        ) : (
          <label>
            {copy.connection}
            <AnchoredSelect
              label={copy.connection}
              value={connectionId}
              disabled={!live.data}
              onChange={(value) => {
                if (value === connectionId) return;
                setConnectionId(value);
                setPlaneProjectId("");
                setStateId("");
              }}
              options={[
                { value: "", label: copy.chooseConnection },
                ...connections.map((item) => ({ value: item.id, label: item.name })),
              ]}
            />
          </label>
        )}
        {connectionId && (
          <label>
            {copy.planeProject}
            <AnchoredSelect
              label={copy.planeProject}
              value={planeProjectId}
              required
              disabled={!projects.data}
              onChange={(value) => {
                setPlaneProjectId(value);
                setStateId("");
              }}
              options={[
                {
                  value: "",
                  label: projects.data
                    ? copy.choosePlaneProject
                    : copy.loadingPlaneProjects,
                },
                ...(projects.data?.projects || []).map((item) => ({
                  value: item.id,
                  label: `${item.identifier} · ${item.name || item.identifier}`,
                })),
              ]}
            />
          </label>
        )}
        <ErrorMessage error={live.error || projects.error || states.error} />
        {started.length > 1 && (
          <div>
            <label>
              {copy.startedState}
              <AnchoredSelect
                label={copy.startedState}
                describedBy="plane-link-state-help"
                value={started.some((item) => item.id === stateId) ? stateId : ""}
                onChange={setStateId}
                options={[
                  { value: "", label: copy.startedStateAuto },
                  ...started.map((item) => ({
                    value: item.id,
                    label: item.name,
                  })),
                ]}
              />
            </label>
            <small id="plane-link-state-help" className="field-description">
              {copy.startedStateHelp}
            </small>
          </div>
        )}
        <div>
          <label>
            {copy.githubLabel}
            <input
              value={label}
              maxLength={100}
              required
              aria-describedby="plane-link-label-help"
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
          <small id="plane-link-label-help" className="field-description">
            {copy.githubLabelHelp}
          </small>
        </div>
        {plane.planeProjectId && (
          <div>
            <button
              type="button"
              className="button secondary"
              disabled={disconnect.busy || saving}
              onClick={() =>
                disconnect.run(async () => {
                  await api(path, "PUT", { plane: null });
                  close();
                })
              }
            >
              {copy.disconnect}
            </button>
            <ErrorMessage error={disconnect.error} />
          </div>
        )}
      </AsyncForm>
    </Modal>
  );
}
