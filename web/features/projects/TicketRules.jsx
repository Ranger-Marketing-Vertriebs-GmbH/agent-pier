import React, { useState } from "react";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import { usePageAction } from "../../app/page-action.js";
import api from "../../lib/api.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { ticketRulesCopy as copy } from "../../lib/i18n/messages/ticket-rules.js";
import { ticketSequenceStartCopy as sequenceCopy } from "../../lib/i18n/messages/ticket-sequences.js";
import { projectTicketsCopy } from "../../lib/i18n/messages/tickets.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import useResource from "../../lib/useResource.js";
import { RowMenu, useRowMenu } from "../extensions/RowMenu.jsx";
import LabelRuleDialog from "./LabelRuleDialog.jsx";
import {
  ruleBody,
  ruleCappedText,
  ruleErrorText,
  rulesPath,
  ruleState,
  ruleTone,
} from "./ticket-rules.js";

const sourceName = (source) =>
  source === "plane" ? projectTicketsCopy.plane : projectTicketsCopy.github;

function RuleRow({ rule, pipelines, busy, onEdit, onToggle, onDelete }) {
  const menu = useRowMenu();
  const pipeline =
    rule.kind === "pipeline" &&
    (pipelines.find((item) => item.id === rule.options?.pipeline?.pipelineId)?.name ||
      sequenceCopy.pipeline);
  const error = rule.status?.error;
  const sub = [
    rule.kind === "pipeline" ? pipeline : sequenceCopy.session,
    rule.options?.allowMerge ? sequenceCopy.allowMerge : "",
    copy.picked(rule.picked || 0),
    error ? ruleErrorText(error.code) : ruleCappedText(rule),
  ]
    .filter(Boolean)
    .join(" · ");
  const name = `${rule.label} · ${sourceName(rule.source)}`;
  return (
    <div className="row-menu-anchor">
      <ListRow
        label={name}
        sub={sub}
        disabled={busy}
        menu={{
          label: copy.rowActions(rule.label),
          expanded: menu.open,
          onClick: menu.toggle,
        }}
      >
        <span className="project-ticket-chip">
          <StatusChip tone={ruleTone(rule)}>{copy[ruleState(rule)]}</StatusChip>
        </span>
      </ListRow>
      <RowMenu
        label={copy.rowActions(rule.label)}
        state={menu}
        items={[
          { id: "edit", label: commonCopy.edit, run: () => onEdit(rule) },
          {
            id: "pause",
            label: rule.paused ? copy.resume : copy.pause,
            run: () => onToggle(rule),
          },
          { id: "delete", label: commonCopy.delete, run: () => onDelete(rule) },
        ]}
      />
    </div>
  );
}

/**
 * The label rules of a project (the `tickets.rules` topic's `view`): one row per rule
 * with its source, what it starts, its pickups and its error, and Add, Edit, Pause or
 * Resume and Delete. A rule queues every open ticket with its label once, the ones
 * labelled before it existed too. `written` is the topic's, so a change stays busy
 * until the pushed list shows it. A failed read (`loadError`) shows its error with
 * `retry` in place of the list.
 */
export default function TicketRules({
  projectId,
  view,
  loadError,
  retry,
  written,
  sources,
  state,
  defaults,
}) {
  const rules = view?.rules || [];
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const action = useAsyncAction();
  const pipelines = useResource(
    rules.some((rule) => rule.kind === "pipeline") ? "/pipelines" : null,
  );
  const open = () => setEditing({});
  // A failed read still lets the owner add a rule: the server checks duplicates and the
  // rule limit itself, and the dialog's save reads the list again.
  const failed = !view && Boolean(loadError);
  usePageAction(
    "ticket-rule-add",
    open,
    Boolean((view || failed) && (sources.github || sources.plane)),
  );
  if (!view && !failed) return null;
  const onToggle = (rule) =>
    action.run(async () => {
      await api(
        rulesPath(projectId, rule.id),
        "PUT",
        ruleBody(rule, { paused: !rule.paused }),
      );
      await written?.();
    });
  return (
    <section className="project-ticket-queue">
      <GroupLabel
        id="project-ticket-rules-heading"
        action={{ label: copy.add, onClick: open }}
      >
        {copy.title}
      </GroupLabel>
      {failed ? (
        <div className="repository-load-error">
          <ErrorMessage error={copy.loadFailed} />
          <button type="button" className="button secondary" onClick={() => retry?.()}>
            {commonCopy.retry}
          </button>
        </div>
      ) : rules.length ? (
        <ListCard labelledBy="project-ticket-rules-heading">
          {rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              pipelines={pipelines.data?.pipelines || []}
              busy={action.busy}
              onEdit={(item) => setEditing({ rule: item })}
              onToggle={onToggle}
              onDelete={setDeleting}
            />
          ))}
        </ListCard>
      ) : (
        <p className="project-empty">{copy.empty}</p>
      )}
      <ErrorMessage error={action.error} />
      {editing && (
        <LabelRuleDialog
          projectId={projectId}
          rule={editing.rule}
          state={state}
          defaults={defaults}
          sources={sources}
          close={() => setEditing(null)}
          onSaved={written}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={copy.deleteTitle(deleting.label)}
          body={copy.deleteBody}
          confirmLabel={commonCopy.delete}
          destructive
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            await api(rulesPath(projectId, deleting.id), "DELETE");
            await written?.();
            setDeleting(null);
          }}
        />
      )}
    </section>
  );
}
