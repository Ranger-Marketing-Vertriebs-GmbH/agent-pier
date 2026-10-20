import React, { useId } from "react";
import Segment from "../../components/Segment.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { profileOptions, stageProfileName } from "./StageFlow.jsx";
import NumberStepper from "./NumberStepper.jsx";
import Switch from "../../components/Switch.jsx";
import GroupMembersEditor from "./GroupMembersEditor.jsx";

// Edits the one stage chosen in the flow. The profile choice lists only profiles
// eligible for stages, plus a saved profile id that no longer is.
export default function StageEditor({
  stages,
  index,
  profiles,
  setStages,
  onMove,
  onRemove,
  disabled = false,
}) {
  const stage = stages[index];
  const number = index + 1;
  const headingId = useId();
  const patch = (change) =>
    setStages(stages.map((s, i) => (i === index ? { ...s, ...change } : s)));
  return (
    <section className="stage-editor" aria-labelledby={headingId}>
      <header>
        <h3 id={headingId}>{copy.editStage(number)}</h3>
        <div className="stage-editor-actions">
          <button
            type="button"
            className="button secondary compact"
            aria-label={`${copy.moveForward} ${number}`}
            // A parallel group never becomes the first stage.
            disabled={index === 0 || (index === 1 && stage.kind === "parallel")}
            onClick={() => onMove(index, -1)}
          >
            {copy.moveForward}
          </button>
          <button
            type="button"
            className="button secondary compact"
            aria-label={`${copy.moveBackward} ${number}`}
            disabled={
              index === stages.length - 1 ||
              (index === 0 && stages[1]?.kind === "parallel")
            }
            onClick={() => onMove(index, 1)}
          >
            {copy.moveBackward}
          </button>
          <button
            type="button"
            className="button secondary compact"
            aria-label={`${copy.removeStage} ${number}`}
            onClick={() => onRemove(index)}
          >
            {copy.removeStage}
          </button>
        </div>
      </header>
      {stage.kind === "parallel" ? (
        <GroupMembersEditor
          stage={stage}
          profiles={profiles}
          patch={patch}
          disabled={disabled}
        />
      ) : (
        <div className="stage-field">
          <span aria-hidden="true">{copy.profile}</span>
          <Segment
            label={copy.profile}
            className="stage-pills"
            required
            disabled={disabled}
            value={stage.profileId}
            options={profileOptions(profiles, stage.profileId)}
            onChange={(value) => patch({ profileId: value })}
          />
          <small>{copy.profileEligibility}</small>
        </div>
      )}
      <div className="stage-checks">
        {[
          ["gate", copy.humanGate],
          ["verify", copy.verifyStage],
          ["createPr", copy.createPr],
        ].map(([field, label]) => (
          <Switch
            key={field}
            className="pipeline-check"
            label={label}
            checked={stage[field]}
            onChange={(checked) => {
              // Only one stage may open the pull request.
              if (field === "createPr" && checked)
                setStages(stages.map((s, i) => ({ ...s, createPr: i === index })));
              else patch({ [field]: checked });
            }}
          />
        ))}
      </div>
      {index > 0 && (
        <div className="stage-loop">
          <div className="stage-field">
            <span aria-hidden="true">{copy.loopTarget}</span>
            <Segment
              label={copy.loopTarget}
              className="stage-pills"
              disabled={disabled}
              value={stage.loopBackTo}
              options={[
                { value: "", label: copy.noLoop },
                // A loop returns to an earlier profile stage, never into a group.
                ...stages.slice(0, index).flatMap((s, i) =>
                  s.kind === "parallel"
                    ? []
                    : [
                        {
                          value: s.key,
                          label: `${i + 1} · ${stageProfileName(s, profiles) || copy.chooseProfile}`,
                        },
                      ],
                ),
              ]}
              onChange={(value) => patch({ loopBackTo: value })}
            />
          </div>
          {stage.loopBackTo && (
            <NumberStepper
              label={copy.loopBudget}
              decreaseLabel={copy.decreaseRounds}
              increaseLabel={copy.increaseRounds}
              min={1}
              max={5}
              value={stage.maxIterations}
              disabled={disabled}
              onChange={(value) => patch({ maxIterations: value })}
            />
          )}
          {stage.loopBackTo && (
            <div className="stage-session">
              <div className="stage-checks">
                <Switch
                  className="pipeline-check"
                  label={copy.continueSession}
                  aria-describedby={`${headingId}-session`}
                  disabled={disabled}
                  checked={stage.continueSession === true}
                  onChange={(checked) => patch({ continueSession: checked })}
                />
              </div>
              <small id={`${headingId}-session`}>{copy.continueSessionHint}</small>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
