import React, { useId, useState } from "react";
import ConfirmDialog from "../../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import { leadRequestCopy } from "../../../lib/i18n/messages/lead-requests.js";
import { RowMenu, useRowMenu } from "../../extensions/RowMenu.jsx";
import { assistantApi } from "../assistant-api.js";
import { groupedMembers } from "../member-group-view.js";
import useAssistants from "../useAssistants.js";
import useTeamActions from "../useTeamActions.js";
import { groupMenuItems, memberMenuItems } from "./member-group-menu.js";

/** A list row with its ⋯ menu (RowMenu). */
function MenuRow({ label, sub, value, menuLabel, items, disabled, className }) {
  const menu = useRowMenu();
  return (
    <>
      <ListRow
        className={className}
        label={label}
        sub={sub}
        value={value}
        disabled={disabled}
        menu={{ label: menuLabel, expanded: menu.open, onClick: menu.toggle }}
      />
      <RowMenu label={menuLabel} state={menu} items={items} />
    </>
  );
}

/** Create or rename a group: its name in a confirmation dialog. */
function NameDialog({ group, onCancel, onSave }) {
  const copy = leadRequestCopy.groups;
  const [name, setName] = useState(group?.name ?? "");
  return (
    <ConfirmDialog
      title={group ? copy.renameTitle(group.name) : copy.newGroup}
      confirmLabel={group ? copy.save : copy.create}
      confirmDisabled={!name.trim()}
      onCancel={onCancel}
      onConfirm={() => onSave(name.trim())}
    >
      <label>
        {copy.name}
        <input
          value={name}
          maxLength={60}
          autoComplete="off"
          data-autofocus
          onChange={(event) => setName(event.target.value)}
        />
      </label>
    </ConfirmDialog>
  );
}

/**
 * Team tab: the lead's named groups of permanent members (server member-groups.js).
 * The owner creates, renames and deletes groups and moves members between them, as
 * the lead can with its team tools; a move is one step and never stops a task.
 */
export default function MemberGroupsGroup({ assistant }) {
  const copy = leadRequestCopy.groups;
  const { assistants = [], members = [], groups = [], refresh } = useAssistants();
  const { busy, error, act } = useTeamActions();
  const [dialog, setDialog] = useState(null);
  const id = useId();
  const permanent = assistants.filter(
    (a) =>
      a.parentAssistantId === assistant.id &&
      a.teamMemberId &&
      a.lifetime === "permanent" &&
      !a.archivedAt,
  );
  const own = groups.filter((g) => g.parentAssistantId === assistant.id);
  if (assistant.teamMemberId || (!permanent.length && !own.length)) return null;
  const view = groupedMembers(assistant.id, permanent, members, own);
  const recordOf = (agent) => members.find((m) => m.assistantId === agent.id);
  const groupOf = (memberId) => own.find((g) => g.memberIds.includes(memberId));
  const move = (memberId, groupId) =>
    act(() => assistantApi.moveMemberToGroup(memberId, groupId));
  const memberRow = (agent) => {
    const record = recordOf(agent);
    if (!record) return null;
    return (
      <MenuRow
        key={agent.id}
        className="member-group-member"
        label={agent.name}
        sub={record.role}
        disabled={busy}
        menuLabel={copy.memberActions(agent.name)}
        items={memberMenuItems({
          groups: own,
          current: groupOf(record.id),
          onMove: (groupId) => move(record.id, groupId),
          onNewGroup: () => setDialog({ kind: "create", memberId: record.id }),
        })}
      />
    );
  };
  const close = () => setDialog(null);
  const save = async (name) => {
    if (dialog.kind === "rename")
      await assistantApi.renameMemberGroup(dialog.group.id, name);
    else {
      const group = await assistantApi.createMemberGroup(assistant.id, name);
      if (dialog.memberId)
        await assistantApi.moveMemberToGroup(dialog.memberId, group.id);
    }
    await refresh();
    close();
  };
  return (
    <section id="agent-member-groups" aria-labelledby={id}>
      <GroupLabel
        id={id}
        hint={copy.hint}
        action={{
          label: copy.newGroup,
          disabled: busy,
          onClick: () => setDialog({ kind: "create" }),
        }}
      >
        {copy.title}
      </GroupLabel>
      <ErrorMessage error={error} />
      {!own.length && <p className="agent-row-note">{copy.none}</p>}
      {view.groups.map(({ group, children }) => (
        <ListCard key={group.id} label={group.name} className="member-group-card">
          <MenuRow
            className="member-group-head"
            label={group.name}
            value={copy.count(children.length)}
            disabled={busy}
            menuLabel={copy.groupActions(group.name)}
            items={groupMenuItems({
              onRename: () => setDialog({ kind: "rename", group }),
              onDelete: () => setDialog({ kind: "delete", group }),
            })}
          />
          {children.length ? (
            children.map(memberRow)
          ) : (
            <p className="agent-row-note">{copy.empty}</p>
          )}
        </ListCard>
      ))}
      {view.ungrouped.length > 0 && (
        <ListCard label={copy.ungrouped} className="member-group-card">
          <ListRow
            className="member-group-head"
            label={copy.ungrouped}
            value={copy.count(view.ungrouped.length)}
          />
          {view.ungrouped.map(memberRow)}
        </ListCard>
      )}
      {(dialog?.kind === "create" || dialog?.kind === "rename") && (
        <NameDialog group={dialog.group} onCancel={close} onSave={save} />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          destructive
          title={copy.removeTitle(dialog.group.name)}
          body={copy.removeBody}
          confirmLabel={copy.remove}
          onCancel={close}
          onConfirm={async () => {
            await assistantApi.deleteMemberGroup(dialog.group.id);
            await refresh();
            close();
          }}
        />
      )}
    </section>
  );
}
