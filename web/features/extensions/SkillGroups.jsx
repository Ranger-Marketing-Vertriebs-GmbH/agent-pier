import React, { useId } from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import "./skill-list.css";

/**
 * One skill in a list: its name, the description cut after two lines, an optional
 * `note` below it (a limit or a finding) and a short trailing `value`. The row opens
 * the skill's detail view.
 */
export function SkillRow({ name, description, note, value, onClick, disabled }) {
  return (
    <ListRow
      label={name}
      sub={
        <>
          {description && <span className="skill-row-description">{description}</span>}
          {note && <span className="skill-row-note">{note}</span>}
        </>
      }
      value={value}
      onClick={onClick}
      disabled={disabled}
    />
  );
}

function SkillGroup({ group, row }) {
  const id = useId();
  return (
    <section className="skill-group">
      <GroupLabel id={id}>{group.title}</GroupLabel>
      {group.meta && <p className="skill-group-meta">{group.meta}</p>}
      <ListCard labelledBy={id} className="extension-list skill-list">
        {group.skills.map(row)}
      </ListCard>
    </section>
  );
}

/**
 * Skills grouped by their source (see `groupSkills`): each group is a label, a line
 * with what its skills share (`meta`) and a card of rows rendered by `row(skill)`.
 */
export default function SkillGroups({ label, groups, row }) {
  return (
    <div className="skill-groups" role="group" aria-label={label}>
      {groups.map((group) => (
        <SkillGroup key={group.key} group={group} row={row} />
      ))}
    </div>
  );
}
