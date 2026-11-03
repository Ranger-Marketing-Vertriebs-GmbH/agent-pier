import React, { useEffect, useState } from "react";
import Checkbox from "../../components/Checkbox.jsx";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import ReferenceRow from "../../components/ReferenceRow.jsx";
import SearchSelect from "../../components/SearchSelect.jsx";
import Segment from "../../components/Segment.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import { usePageAction } from "../../app/page-action.js";
import api from "../../lib/api.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import {
  projectTicketsCopy as copy,
  ticketErrorCopy,
} from "../../lib/i18n/messages/tickets.js";
import { ticketSequenceStartCopy as sequenceCopy } from "../../lib/i18n/messages/ticket-sequences.js";
import useLiveTopic from "../../lib/live/useLiveTopic.js";
import { connectionsRoute, connectionsRoutePath } from "../connections/routes.js";
import { RowMenu, useRowMenu } from "../extensions/RowMenu.jsx";
import NewRunDialog from "../pipelines/NewRunDialog.jsx";
import ProjectTicketSources from "./ProjectTicketSources.jsx";
import SequenceStartDialog from "./SequenceStartDialog.jsx";
import TicketQueue from "./TicketQueue.jsx";
import TicketRules from "./TicketRules.jsx";
import { RegisterHint } from "./ProjectRuns.jsx";
import { pipelineRunRoute } from "./routes.js";
import { sourceStates, startOf, startRoute, visibleTickets } from "./ticket-list.js";
import { queueItemPath } from "./ticket-queue.js";
import { rulesPath } from "./ticket-rules.js";
import "./project-tickets.css";

const enc = encodeURIComponent;
const sourceName = (source) => (source === "plane" ? copy.plane : copy.github);
const codeText = (code) => ticketErrorCopy[code] || ticketErrorCopy.invalidResponse;
const ticketId = (ticket) => `${ticket.source}\n${ticket.key}`;

function TicketRow({ ticket, start, onStart, onOpen, selected }) {
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
        {selected && (
          <span className="project-ticket-chip">
            <Checkbox
              label={
                <span className="visually-hidden">
                  {sequenceCopy.selectTicket(ticket.key)}
                </span>
              }
              checked={selected.checked}
              onChange={selected.onChange}
            />
          </span>
        )}
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

function NoSources({ onNavigate, refresh }) {
  const github = connectionsRoute("github"),
    tickets = connectionsRoute("tickets");
  return (
    <div className="project-tickets-empty">
      <p className="project-empty">
        <strong>{copy.noSources}</strong> {copy.noSourcesBody}
      </p>
      <div className="project-tickets-toolbar">{refresh}</div>
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
 * sends only source and key. A started ticket asks before it starts again. The
 * project's ticket sequence shows above the list while it has items, its label rules
 * below the sequence while a source is connected.
 */
export default function ProjectTickets({
  project,
  route,
  onNavigate,
  onLaunch,
  launchState,
  home,
  reloadHub,
}) {
  const projectId = project.id;
  // A project known only to AgentBus has no folder the ticket routes resolve; it gets
  // the register hint and reads nothing.
  const registered = Boolean(project.memoryId || project.repositoryId);
  const live = useLiveTopic(
    registered ? `tickets.project:${projectId}` : null,
    `/tickets/projects/${enc(projectId)}`,
  );
  const view = live.data;
  const queue = useLiveTopic(
    registered ? `tickets.queue:${projectId}` : null,
    queueItemPath(projectId),
  );
  // The label rules; the queue names the rule a ticket came from.
  const rules = useLiveTopic(
    registered ? `tickets.rules:${projectId}` : null,
    rulesPath(projectId),
  );
  const [version, setVersion] = useState(0);
  const [source, setSource] = useState("");
  const [confirming, setConfirming] = useState(null);
  const [runTicket, setRunTicket] = useState(null);
  // Selection mode: the chosen tickets (source + key) and the open sequence dialog.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [sequencing, setSequencing] = useState(false);
  // Keys of selected tickets that a refresh no longer lists, so they were deselected.
  const [dropped, setDropped] = useState([]);
  const list = useTicketList(
    projectId,
    view ? JSON.stringify(view.sources) : "",
    version,
  );
  useEffect(() => {
    if (!list.data) return;
    const listed = new Set((list.data.tickets || []).map(ticketId));
    const gone = [...selected].filter((id) => !listed.has(id));
    if (!gone.length) return;
    setSelected(new Set([...selected].filter((id) => listed.has(id))));
    setDropped(gone.map((id) => id.slice(id.indexOf("\n") + 1)));
    // Only a new list deselects; toggling a ticket never does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data]);
  // The ⌘K action "Start tickets" turns selection mode on once the list is there.
  usePageAction(
    "tickets-sequence",
    () => setSelecting(true),
    Boolean(list.data?.tickets?.length),
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
  // The selected tickets in list order, also those a filter hides right now.
  const chosen = (list.data?.tickets || []).filter((ticket) =>
    selected.has(ticketId(ticket)),
  );
  const toggle = (ticket, on) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(ticketId(ticket));
      else next.delete(ticketId(ticket));
      return next;
    });
  const endSelection = () => {
    setSelecting(false);
    setSelected(new Set());
    setDropped([]);
  };
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
  // Refresh re-reads the whole view (the sources too, e.g. after a git remote change)
  // and the remote ticket list.
  const refresh = (
    <button
      type="button"
      className="button secondary compact"
      disabled={list.loading}
      onClick={() => {
        live.refresh();
        setVersion((value) => value + 1);
      }}
    >
      {commonCopy.refresh}
    </button>
  );
  const onStart = (ticket, kind) =>
    startOf(view?.starts, ticket)
      ? setConfirming({ ticket, kind })
      : begin(ticket, kind, false);
  if (!registered)
    return (
      <RegisterHint
        project={project}
        onNavigate={onNavigate}
        reloadHub={reloadHub}
        text={copy.unregistered}
        tab="tickets"
      />
    );
  return (
    <div className="project-tickets">
      <ProjectTicketSources view={view} projectId={projectId} onNavigate={onNavigate} />
      <TicketQueue
        projectId={projectId}
        view={queue.data}
        written={queue.written}
        rules={rules.data?.rules}
        onNavigate={onNavigate}
      />
      {view && (connected.github || connected.plane) && (
        <TicketRules
          projectId={projectId}
          view={rules.data}
          loadError={rules.error}
          retry={rules.refresh}
          written={rules.written}
          sources={connected}
          state={launchState}
          defaults={queue.data?.defaults}
        />
      )}
      {live.error && !view && <ErrorMessage error={copy.loadFailed} />}
      {live.loading && !view && <p role="status">{copy.loading}</p>}
      {view && !connected.github && !connected.plane && (
        <NoSources onNavigate={onNavigate} refresh={refresh} />
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
            {refresh}
            {selecting ? (
              <>
                <button
                  type="button"
                  className="button primary compact"
                  disabled={!chosen.length}
                  onClick={() => setSequencing(true)}
                >
                  {sequenceCopy.startSelected(chosen.length)}
                </button>
                <button
                  type="button"
                  className="button secondary compact"
                  onClick={endSelection}
                >
                  {commonCopy.cancel}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="button secondary compact"
                disabled={!list.data?.tickets?.length}
                onClick={() => setSelecting(true)}
              >
                {sequenceCopy.select}
              </button>
            )}
          </div>
          {errors.map((error) => (
            <ErrorMessage
              key={error.source}
              error={copy.sourceError(sourceName(error.source), codeText(error.code))}
            />
          ))}
          <ErrorMessage error={list.error} />
          {selecting && dropped.length > 0 && (
            <p role="status" className="field-description">
              {sequenceCopy.deselected(dropped.join(", "))}
            </p>
          )}
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
                  selected={
                    selecting && {
                      checked: selected.has(ticketId(ticket)),
                      onChange: (on) => toggle(ticket, on),
                    }
                  }
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
      {sequencing && (
        <SequenceStartDialog
          projectId={projectId}
          tickets={chosen}
          state={launchState}
          defaults={queue.data?.defaults}
          close={() => setSequencing(false)}
          onStarted={async () => {
            await queue.written();
            setSequencing(false);
            endSelection();
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
