import React, { useId } from "react";
import Segment from "../../components/Segment.jsx";
import { browserUuid } from "../../lib/browser-uuid.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { MAX_GROUP_MEMBERS } from "./graph-editor.js";
import NumberStepper from "./NumberStepper.jsx";
import { profileOptions } from "./StageFlow.jsx";

// The members of a parallel group: one profile each, 2–8 of them, and how many run at
// the same time (all of them unless the owner caps it).
export default function GroupMembersEditor({ stage, profiles, patch, disabled }) {
  const members = stage.members;
  const hintId = useId();
  // Each member runs a profile of its own, so there are never more members than
  // eligible profiles.
  const exhausted = members.length >= profiles.length;
  const setMembers = (next) =>
    patch({
      members: next,
      // A cap the smaller group no longer allows falls back to all members.
      concurrency:
        stage.concurrency !== undefined && stage.concurrency < next.length
          ? stage.concurrency
          : undefined,
    });
  return (
    <div className="stage-group">
      <p className="field-description">{copy.parallelGroupHint}</p>
      {members.map((member, index) => (
        <div className="stage-field stage-group-member" key={member.key}>
          <span aria-hidden="true">{copy.memberNumber(index + 1)}</span>
          <Segment
            label={copy.memberNumber(index + 1)}
            className="stage-pills"
            required
            disabled={disabled}
            value={member.profileId}
            // A profile another member already runs is not offered again.
            options={profileOptions(
              profiles.filter(
                (profile) =>
                  profile.id === member.profileId ||
                  !members.some((m) => m.profileId === profile.id),
              ),
              member.profileId,
            )}
            onChange={(value) =>
              setMembers(
                members.map((m, i) => (i === index ? { ...m, profileId: value } : m)),
              )
            }
          />
          <button
            type="button"
            className="button secondary compact"
            aria-label={copy.removeMember(index + 1)}
            disabled={disabled || members.length <= 2}
            onClick={() => setMembers(members.filter((_, i) => i !== index))}
          >
            {copy.removeMemberShort}
          </button>
        </div>
      ))}
      <button
        type="button"
        className="button secondary compact"
        aria-describedby={exhausted ? hintId : undefined}
        disabled={disabled || members.length >= MAX_GROUP_MEMBERS || exhausted}
        onClick={() =>
          setMembers([...members, { key: `member-${browserUuid()}`, profileId: "" }])
        }
      >
        {copy.addMember}
      </button>
      {exhausted && <small id={hintId}>{copy.noFreeProfile}</small>}
      <NumberStepper
        label={copy.concurrency}
        decreaseLabel={copy.decreaseConcurrency}
        increaseLabel={copy.increaseConcurrency}
        min={1}
        max={members.length}
        value={stage.concurrency ?? members.length}
        disabled={disabled}
        onChange={(value) =>
          patch({ concurrency: value === members.length ? undefined : value })
        }
      />
    </div>
  );
}
