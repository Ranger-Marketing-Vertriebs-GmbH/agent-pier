import React, { useId, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow, { ToggleRow, unknownValue } from "../../../components/ListRow.jsx";
import StatusDot from "../../../components/StatusDot.jsx";
import { agentsHubCopy } from "../../../lib/i18n/messages/agents-hub.js";
import { assistantApi } from "../assistant-api.js";
import {
  BlockerList,
  PauseAndUpdate,
  blocksPause,
  validBlockerItem,
} from "../RuntimeUpdateBlockers.jsx";
import { hermesBusy, hermesErrorText, hermesStatus } from "../hermes-runtime.js";
import useHermesRuntime from "../useHermesRuntime.js";
import { updateCauseDetail } from "../update-cause.js";

const copy = () => agentsHubCopy.runtime.hermes;
// Hermes Agent's update, for "Pause agents and update".
const hermesUpdate = {
  blockers: "/assistant-runtime/hermes/update/blockers",
  activate: "/assistant-runtime/hermes/update",
};

/**
 * Laufzeit › Hermes Agent: the second agent runtime. Its switch installs Hermes in the
 * background and its update installs the pinned version; both are immediate actions,
 * never part of the tab's draft. Work of Hermes agents that refused the update is
 * listed, each item opening where it is resolved, beside "Pause agents and update".
 * A server without Hermes (404) shows no group.
 */
export default function RuntimeHermesGroup({ navigate }) {
  const id = useId();
  const hermes = useHermesRuntime();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { state } = hermes;
  if (hermes.missing) return null;
  const act = async (request) => {
    setBusy(true);
    setError("");
    try {
      hermes.setState(await request());
    } catch (e) {
      setError(e.message);
      await hermes.load();
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
      : copy().states[status.kind];
  const versionSub = [
    state?.pythonVersion && copy().python(state.pythonVersion),
    state?.targetVersion &&
      state.targetVersion !== state.version &&
      copy().target(state.targetVersion),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <section aria-labelledby={id}>
      <GroupLabel id={id} hint={copy().hint}>
        {copy().title}
      </GroupLabel>
      <ErrorMessage error={error || hermes.error} />
      {state && (
        <ListCard labelledBy={id}>
          <ToggleRow
            label={copy().enable}
            sub={copy().enableSub}
            checked={state.enabled}
            disabled={working}
            onChange={(enabled) => act(() => assistantApi.setHermes(enabled))}
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
                  onClick={() => act(() => assistantApi.updateHermes())}
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
                      await hermes.load();
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
      )}
      {!!blockers.length && <BlockerList items={blockers} navigate={navigate} />}
    </section>
  );
}
