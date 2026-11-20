import React, { useId, useState } from "react";
import ErrorMessage from "../../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../../components/GroupLabel.jsx";
import ListCard from "../../../../components/ListCard.jsx";
import ListRow, { ToggleRow, unknownValue } from "../../../../components/ListRow.jsx";
import StatusDot from "../../../../components/StatusDot.jsx";
import { agentsHubCopy } from "../../../../lib/i18n/messages/agents-hub.js";
import { hermesApi } from "./api.js";
import {
  BlockerList,
  PauseAndUpdate,
  blocksPause,
  validBlockerItem,
} from "../../RuntimeUpdateBlockers.jsx";
import { updateCauseDetail } from "../../update-cause.js";
import {
  hermesBusy,
  hermesErrorText,
  hermesInstallStep,
  hermesStatus,
  validHermes,
} from "./install-state.js";

const copy = () => agentsHubCopy.runtime.hermes;
// "Installing Hermes Agent: step 3 of 5, …", or "" without a known step.
const installStepText = (at) =>
  at ? copy().installStep(at.index, at.of, copy().installSteps[at.step]) : "";
// Hermes Agent's update, for "Pause agents and update".
const hermesUpdate = {
  blockers: "/assistant-runtime/hermes/update/blockers",
  activate: "/assistant-runtime/hermes/update",
};

/**
 * Laufzeit › Hermes Agent, Hermes's `install` surface in the slot `hub.runtime`
 * (RuntimeSlot.jsx): the second agent runtime. Its switch installs Hermes in the
 * background and its update installs the pinned version; both are immediate actions,
 * never part of the tab's draft. Work of Hermes agents that refused the update is
 * listed, each item opening where it is resolved, beside "Pause agents and update".
 * Its state is the install state of `runtime`, Hermes's entry of the runtime list,
 * pushed live; after an action the control stays busy until the change shows
 * (`list.written()`). `context.navigate` opens a blocker's place, and `anchor` is the
 * element id a link to the slot scrolls to. An entry without an install state shows
 * no group.
 */
export default function InstallSurface({ runtime, context, list, anchor }) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const state = validHermes(runtime.install);
  if (!state) return null;
  const act = async (request) => {
    setBusy(true);
    setError("");
    try {
      await request();
      await list.written();
    } catch (e) {
      setError(e.message);
      await list.refresh();
    } finally {
      setBusy(false);
    }
  };
  const status = hermesStatus(state);
  const working = busy || hermesBusy(state);
  const blockers =
    state?.error === "UPDATE_BLOCKED" && Array.isArray(state.blockerItems)
      ? state.blockerItems.filter(validBlockerItem)
      : [];
  const cause = status.kind === "error" ? updateCauseDetail(state.errorCause) : "";
  const statusText =
    status.kind === "error"
      ? [
          hermesErrorText(state.error, copy().errors, copy().unknownError),
          cause && copy().cause(cause),
        ]
          .filter(Boolean)
          .join(" ")
      : installStepText(hermesInstallStep(state)) || copy().states[status.kind];
  const versionSub = [
    state?.pythonVersion && copy().python(state.pythonVersion),
    state?.targetVersion &&
      state.targetVersion !== state.version &&
      copy().target(state.targetVersion),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <section id={anchor} aria-labelledby={id}>
      <GroupLabel id={id} hint={copy().hint}>
        {copy().title}
      </GroupLabel>
      <ErrorMessage error={error || list.error} />
      <ListCard labelledBy={id}>
        <ToggleRow
          label={copy().enable}
          sub={copy().enableSub}
          checked={state.enabled}
          disabled={working}
          onChange={(enabled) => act(() => hermesApi.set(enabled))}
        />
        <ListRow
          label={copy().state}
          icon={<StatusDot tone={status.tone} />}
          sub={statusText}
        />
        {state.installed && (
          <ListRow
            label={copy().version}
            sub={versionSub || undefined}
            value={state.version || unknownValue}
          />
        )}
        {state.installed && state.updateAvailable && (
          <ListRow
            label={
              state.targetVersion ? copy().updateTo(state.targetVersion) : copy().update
            }
            sub={copy().updateNote}
          >
            <div className="agents-hub-row-actions">
              <button
                type="button"
                className="button secondary compact"
                disabled={working}
                onClick={() => act(() => hermesApi.update())}
              >
                {copy().update}
              </button>
              {!!blockers.length && (
                <PauseAndUpdate
                  version={state.targetVersion || ""}
                  disabled={working || blocksPause(blockers)}
                  endpoints={hermesUpdate}
                  onDone={async (message) => {
                    setError(message);
                    await list.written();
                  }}
                />
              )}
            </div>
          </ListRow>
        )}
        <ListRow
          label={copy().agents}
          value={Number.isSafeInteger(state.agents) ? state.agents : unknownValue}
        />
      </ListCard>
      {!!blockers.length && <BlockerList items={blockers} navigate={context.navigate} />}
    </section>
  );
}
