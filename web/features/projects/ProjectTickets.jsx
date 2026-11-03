import React, { useEffect, useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import ReferenceRow from "../../components/ReferenceRow.jsx";
import SearchSelect from "../../components/SearchSelect.jsx";
import Segment from "../../components/Segment.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import api from "../../lib/api.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import {
  projectTicketsCopy as copy,
  ticketErrorCopy,
} from "../../lib/i18n/messages/tickets.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { connectionsRoute, connectionsRoutePath } from "../connections/routes.js";
import { RowMenu, useRowMenu } from "../extensions/RowMenu.jsx";
import NewRunDialog from "../pipelines/NewRunDialog.jsx";
import ProjectTicketSources from "./ProjectTicketSources.jsx";
import { pipelineRunRoute } from "./routes.js";
import { sourceStates, startOf, startRoute, visibleTickets } from "./ticket-list.js";
import "./project-tickets.css";

const enc = encodeURIComponent;
const sourceName = (source) => (source === "plane" ? copy.plane : copy.github);
const codeText = (code) => ticketErrorCopy[code] || ticketErrorCopy.invalidResponse;

function TicketRow({ ticket, start, onStart, onOpen }) {
  const menu = useRowMenu();
  const failed = start?.writeBack?.state === "failed";
  const sub = [
    (ticket.labels || []).join(", "),
    failed ? copy.writeBackDetail(codeText(start.writeBack.code)) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const items = [
    { id: "session", label: copy.startSession, run: () => onStart(ticket, "session") },
    { id: "pipeline", label: copy.startRun, run: () => onStart(ticket, "pipeline") },
    ...(start
      ? [
          {
            id: "open-start",
            label: start.kind === "pipeline" ? copy.openRun : copy.openSession,
            run: () => onOpen(start),
          },
        ]
      : []),
    ...(ticket.url
      ? [
          {
            id: "open",
            label: copy.openIn(sourceName(ticket.source)),
            run: () => window.open(ticket.url, "_blank", "noopener,noreferrer"),
          },
        ]
      : []),
  ];
  return (
    <div className="row-menu-anchor">
      <ListRow
        label={`${ticket.key} ${ticket.title}`}
        sub={sub}
        menu={{
          label: copy.rowActions(ticket.key),
          expanded: menu.open,
          onClick: menu.toggle,
        }}
      >
        {start && (
          <span className="project-ticket-chip">
            <StatusChip tone={failed ? "error" : "ok"}>
              {failed ? copy.writeBackFailed : copy.started}
            </StatusChip>
          </span>
        )}
      </ListRow>
      <RowMenu label={copy.rowActions(ticket.key)} state={menu} items={items} />
    </div>
  );
}

function NoSources({ onNavigate }) {
  const github = connectionsRoute("github"),
    tickets = connectionsRoute("tickets");
  return (
    <div className="project-tickets-empty">
      <p className="project-empty">
        <strong>{copy.noSources}</strong> {copy.noSourcesBody}
      </p>
      <ReferenceRow
        title={copy.githubReference}
        sub={copy.githubReferenceSub}
        href={connectionsRoutePath(github)}
        onOpen={() => onNavigate(github)}
      />
      <ReferenceRow
        title={copy.planeReference}
        sub={copy.planeReferenceSub}
        href={connectionsRoutePath(tickets)}
        onOpen={() => onNavigate(tickets)}
      />
    </div>
  );
}

// The remote ticket list: read on open, when the project's sources change and on
// Refresh, never on a timer (the trackers have no push to AgentPier).
function useTicketList(projectId, sourcesKey, version) {
  const [list, setList] = useState(null);
  useEffect(() => {
    if (!sourcesKey) return;
    const controller = new AbortController();
    setList((current) =>
      current?.projectId === projectId ? { ...current, loading: true, error: "" } : null,
    );
    api(
      `/tickets/projects/${enc(projectId)}/tickets`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((data) => setList({ projectId, data, error: "", loading: false }))
      .catch((error) => {
        if (controller.signal.aborted) return;
        setList((current) => ({
          projectId,
          data: current?.projectId === projectId ? current.data : null,
          error: error.message,
          loading: false,
        }));
      });
    return () => controller.abort();
  }, [projectId, sourcesKey, version]);
  if (!sourcesKey || (list && list.projectId !== projectId))
    return { data: null, error: "", loading: Boolean(sourcesKey) };
  return list || { data: null, error: "", loading: true };
}

/**
 * A project's Tickets tab: its ticket sources, the open GitHub issues and Plane work
 * items with a label filter, and the start of one ticket as a session (the launch
 * dialog) or a pipeline run. The server reads the ticket text itself; the browser
 * sends only source and key. A started ticket asks before it starts again.
 */
export default function ProjectTickets({ project, route, onNavigate, onLaunch, home }) {
  const projectId = project.id;
  const live = useLiveTopic(
    `tickets.project:${projectId}`,
    `/tickets/projects/${enc(projectId)}`,
  );
  const view = live.data;
  const [version, setVersion] = useState(0);
  const [source, setSource] = useState("");
  const [confirming, setConfirming] = useState(null);
  const [runTicket, setRunTicket] = useState(null);
  const list = useTicketList(
    projectId,
    view ? JSON.stringify(view.sources) : "",
    version,
  );
  const connected = sourceStates(view);
  const both = connected.github && connected.plane;
  const label = route.ticketLabel || "";
  const labels = list.data?.labels || [];
  const tickets = visibleTickets(list.data?.tickets, {
    label,
    source: both ? source : "",
  });
  const errors = (list.data?.errors || []).filter(
    (error) => error.code !== "notConnected" || connected[error.source],
  );
  const begin = (ticket, kind, again) => {
    const target = {
      projectId,
      source: ticket.source,
      key: ticket.key,
      title: ticket.title,
      again,
    };
    if (kind === "session") onLaunch(project.path, target);
    else setRunTicket(target);
  };
  const onStart = (ticket, kind) =>
    startOf(view?.starts, ticket)
      ? setConfirming({ ticket, kind })
      : begin(ticket, kind, false);
  return (
    <div className="project-tickets">
      <ProjectTicketSources view={view} projectId={projectId} onNavigate={onNavigate} />
      {live.error && !view && <ErrorMessage error={live.error} />}
      {live.loading && !view && <p role="status">{copy.loading}</p>}
      {view && !connected.github && !connected.plane && (
        <NoSources onNavigate={onNavigate} />
      )}
      {view && (connected.github || connected.plane) && (
        <>
          <GroupLabel id="project-tickets-heading">{copy.list}</GroupLabel>
          <div className="project-tickets-toolbar">
            <SearchSelect
              label={copy.label}
              searchLabel={copy.searchLabels}
              value={label}
              options={[
                { value: "", label: copy.allLabels },
                ...[...new Set([...(label ? [label] : []), ...labels])].map((name) => ({
                  value: name,
                  label: name,
                })),
              ]}
              onChange={(ticketLabel) =>
                onNavigate({ ...route, projectId, projectTab: "tickets", ticketLabel })
              }
            />
            {both && (
              <Segment
                label={copy.source}
                value={source}
                onChange={setSource}
                options={[
                  { value: "", label: copy.allSources },
                  { value: "github", label: copy.github },
                  { value: "plane", label: copy.plane },
                ]}
              />
            )}
            <button
              type="button"
              className="button secondary compact"
              disabled={list.loading}
              onClick={() => setVersion((value) => value + 1)}
            >
              {commonCopy.refresh}
            </button>
          </div>
          {errors.map((error) => (
            <ErrorMessage
              key={error.source}
              error={copy.sourceError(sourceName(error.source), codeText(error.code))}
            />
          ))}
          <ErrorMessage error={list.error} />
          {list.loading && !list.data && <p role="status">{copy.loading}</p>}
          {list.data && !tickets.length && (
            <p className="project-empty">{label ? copy.noMatches : copy.noTickets}</p>
          )}
          {tickets.length > 0 && (
            <ListCard labelledBy="project-tickets-heading">
              {tickets.map((ticket) => (
                <TicketRow
                  key={`${ticket.source}:${ticket.key}`}
                  ticket={ticket}
                  start={startOf(view.starts, ticket)}
                  onStart={onStart}
                  onOpen={(start) => onNavigate(startRoute(start))}
                />
              ))}
            </ListCard>
          )}
        </>
      )}
      {confirming && (
        <ConfirmDialog
          title={copy.againTitle(confirming.ticket.key)}
          body={copy.againBody}
          confirmLabel={copy.again}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            begin(confirming.ticket, confirming.kind, true);
          }}
        />
      )}
      {runTicket && (
        <NewRunDialog
          home={home}
          ticket={runTicket}
          close={() => setRunTicket(null)}
          onCreated={(run) => onNavigate(pipelineRunRoute(run.id))}
        />
      )}
    </div>
  );
}
