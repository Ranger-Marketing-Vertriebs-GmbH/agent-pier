import React, { useId, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow, { ToggleRow, unknownValue } from "../../../components/ListRow.jsx";
import StatusDot from "../../../components/StatusDot.jsx";
import { agentsHubCopy } from "../../../lib/i18n/messages/agents-hub.js";
import { assistantApi } from "../assistant-api.js";
import { hermesBusy, hermesErrorText, hermesStatus } from "../hermes-runtime.js";
import useHermesRuntime from "../useHermesRuntime.js";

const copy = () => agentsHubCopy.runtime.hermes;

/**
 * Laufzeit › Hermes Agent: the second agent runtime. Its switch installs Hermes in the
 * background and its update installs the pinned version; both are immediate actions,
 * never part of the tab's draft. A server without Hermes (404) shows no group.
 */
export default function RuntimeHermesGroup() {
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
  const statusText =
    status.kind === "error"
      ? hermesErrorText(state.error, copy().errors, copy().unknownError)
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
              </div>
            </ListRow>
          )}
          <ListRow
            label={copy().agents}
            value={Number.isSafeInteger(state.agents) ? state.agents : unknownValue}
          />
        </ListCard>
      )}
    </section>
  );
}
