import React from "react";
import Icon from "../../components/Icon.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";

// A stage names its profile; a saved id without a known profile stays readable.
export function stageProfileName(stage, profiles) {
  if (stage.kind === "parallel")
    return stage.members
      .map((member) => stageProfileName(member, profiles))
      .filter(Boolean)
      .join(" · ");
  return profiles.find((p) => p.id === stage.profileId)?.name || stage.profileId;
}

// The eligible profiles, plus a saved profile id that no longer is.
export const profileOptions = (profiles, selected) => [
  ...(selected && !profiles.some((p) => p.id === selected)
    ? [{ value: selected, label: selected }]
    : []),
  ...profiles.map((profile) => ({ value: profile.id, label: profile.name })),
];

function stageFlags(stage, stages) {
  const loop = stages.findIndex((s) => s.key === stage.loopBackTo);
  return [
    stage.gate && copy.stageFlags.gate,
    stage.verify && copy.stageFlags.verify,
    stage.createPr && copy.stageFlags.pr,
    stage.loopBackTo && copy.loopTo(loop + 1),
  ].filter(Boolean);
}

// A parallel group's tile names the group and lists its members side by side.
function GroupMembers({ stage, profiles }) {
  return (
    <span className="stage-tile-members">
      {stage.members.map((member) => {
        const name = stageProfileName(member, profiles);
        return (
          <span
            key={member.key}
            className={`stage-tile-member${name ? "" : " placeholder"}`}
          >
            {name || copy.chooseProfile}
          </span>
        );
      })}
    </span>
  );
}

export default function StageFlow({
  stages,
  profiles,
  selected,
  onSelect,
  onAdd,
  onAddGroup,
}) {
  const loops = stages
    .map((stage, index) =>
      stage.loopBackTo
        ? copy.loopCaption(
            stageProfileName(stage, profiles) || copy.stageNumber(index + 1),
            stages.findIndex((s) => s.key === stage.loopBackTo) + 1,
            stage.maxIterations,
          )
        : "",
    )
    .filter(Boolean);
  return (
    <div className="stage-flow-section">
      <span className="stage-caps" aria-hidden="true">
        {copy.stages}
      </span>
      <ol className="stage-flow" aria-label={copy.stages}>
        {stages.map((stage, index) => {
          const name = stageProfileName(stage, profiles);
          return (
            <li key={stage.key}>
              {index > 0 && (
                <span className="stage-flow-arrow" aria-hidden="true">
                  →
                </span>
              )}
              <button
                type="button"
                className={`stage-tile${index === selected ? " selected" : ""}`}
                aria-pressed={index === selected}
                onClick={() => onSelect(index)}
              >
                <span className="stage-tile-number">{copy.stageNumber(index + 1)}</span>
                {stage.kind === "parallel" ? (
                  <>
                    <strong>{copy.parallelGroup}</strong>
                    <GroupMembers stage={stage} profiles={profiles} />
                  </>
                ) : (
                  <strong className={name ? "" : "placeholder"}>
                    {name || copy.chooseProfile}
                  </strong>
                )}
                <small>
                  {stageFlags(stage, stages).join(" · ") || copy.noStageFlags}
                </small>
              </button>
            </li>
          );
        })}
        <li>
          <button type="button" className="stage-add" onClick={onAdd}>
            <Icon name="plus" size={14} />
            {copy.addStage}
          </button>
        </li>
        <li>
          <button type="button" className="stage-add" onClick={onAddGroup}>
            <Icon name="plus" size={14} />
            {copy.addParallelGroup}
          </button>
        </li>
      </ol>
      {loops.length > 0 && <p className="stage-loop-caption">↺ {loops.join(" · ")}</p>}
    </div>
  );
}
