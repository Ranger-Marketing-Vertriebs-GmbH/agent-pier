import React, { useEffect, useId, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import ListCard from "../../../components/ListCard.jsx";
import { ToggleRow } from "../../../components/ListRow.jsx";
import { assistantShellCopy } from "../../../lib/i18n/messages/assistant-shell.js";
import { mcpCliCopy } from "../../../lib/i18n/messages/mcp-cli.js";
import { mcpPackageCopy } from "../../../lib/i18n/messages/mcp-packages.js";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { names } from "../../../lib/providers.js";
import { shellLevel } from "../../assistants/shell-level.js";
import { cliSupport, clis as allClis } from "../cli-support.js";
import ConsentCard from "./ConsentCard.jsx";
import { connectApi } from "./connect-api.js";
import {
  connectDiff,
  notConnected,
  ownerManaged,
  PACKAGE_NOT_READY,
  runConnect,
} from "./connect-plan.js";
import { writeSwitch } from "./setting-hints.js";
import useConnectTargets from "./useConnectTargets.js";
import WizardStep from "./WizardStep.jsx";

const toggle = (list, value, on) =>
  on
    ? [...list.filter((item) => item !== value), value]
    : list.filter((item) => item !== value);

/**
 * "Who may use <name>?": coding CLIs and agents on one screen with one consent card.
 * A new server whose package still installs keeps the choice and connects once it is
 * ready (Q7); a saved one gets no new target before its package is ready.
 */
export function ConnectForm({
  mode,
  server,
  packageShown,
  agentsEnabled,
  write,
  data,
  navigate,
  headingRef,
  titleTag,
  onFinished,
  onSkip,
  skipLabel = copy.connect.skip,
  setWaiting = () => {},
}) {
  const id = useId();
  const targets = useConnectTargets(agentsEnabled);
  const agentsList = ownerManaged(targets.assistants ?? []);
  const [clis, setClis] = useState(server.clis || []);
  const [agents, setAgents] = useState(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaitingHere] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (targets.assistants && agents === null)
      setAgents(
        agentsList.filter((a) => a.mcpServers.includes(server.id)).map((a) => a.id),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets.assistants]);
  const chosen = agents ?? [];
  const stdio = server.transport === "stdio";
  const notReady = Boolean(server.source) && packageShown !== "ready";
  const installing =
    mode === "new" && Boolean(server.source) && packageShown === "installing";
  const locked = mode === "edit" && notReady;
  const diff = connectDiff({ server, clis, agents: chosen, assistants: agentsList });
  const target = { transport: server.transport, cwd: server.cwd || "" };
  const wait = (on) => {
    setWaitingHere(on);
    setWaiting(on);
  };
  const run = async () => {
    setBusy(true);
    setError("");
    try {
      const results = await runConnect({
        diff,
        serverId: server.id,
        consented: diff.needsConsent,
        api: connectApi(data),
      });
      await data.reloadMcp();
      onFinished(results, { diff, consented: diff.needsConsent });
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!waiting) return;
    if (packageShown === "ready") {
      wait(false);
      run();
    } else if (["failed", "missing"].includes(packageShown)) {
      wait(false);
      onFinished(notConnected(diff, PACKAGE_NOT_READY), {
        diff,
        consented: diff.needsConsent,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, packageShown]);
  useEffect(() => () => setWaiting(false), [setWaiting]);
  const primaryLabel = installing
    ? copy.connect.whenInstalled
    : diff.needsConsent
      ? copy.connect.allow
      : mode === "edit"
        ? copy.connect.saveChanges
        : copy.connect.save;
  const frozen = busy || waiting;
  return (
    <WizardStep
      title={copy.connect.title(server.name)}
      headingRef={headingRef}
      titleTag={titleTag}
      busy={busy}
      primary={{ label: primaryLabel, disabled: waiting, describedBy: `${id}-consent` }}
      secondary={{ label: skipLabel, onClick: onSkip, disabled: waiting }}
      onSubmit={() => (installing ? wait(true) : run())}
    >
      <p className="mcp-hint">{copy.connect.intro}</p>
      <ListCard label={copy.connect.clis}>
        {allClis.map((cli) => {
          const support = cliSupport(cli, target);
          const bound = (server.clis || []).includes(cli);
          return (
            <ToggleRow
              key={cli}
              label={names[cli]}
              sub={
                support.supported
                  ? locked && !bound
                    ? mcpPackageCopy.bindingLocked
                    : copy.connect.cliHint
                  : mcpCliCopy.unsupported[support.reason]
              }
              checked={support.supported && clis.includes(cli)}
              disabled={frozen || !support.supported || (locked && !bound)}
              onChange={(on) => setClis(toggle(clis, cli, on))}
            />
          );
        })}
      </ListCard>
      {agentsEnabled && (
        <ListCard label={copy.connect.agents}>
          {targets.assistants === null && (
            <p role="status">{copy.connect.agentsLoading}</p>
          )}
          {targets.error && (
            <p className="mcp-field-error">{copy.connect.agentsFailed}</p>
          )}
          {agentsList.map((item) => {
            const bound = item.mcpServers.includes(server.id);
            const telegram = stdio && item.telegramSenders === true && !bound;
            return (
              <ToggleRow
                key={item.id}
                label={item.name}
                sub={
                  telegram
                    ? copy.connect.telegramLocked
                    : locked && !bound
                      ? mcpPackageCopy.bindingLocked
                      : copy.connect.shell(assistantShellCopy.levels[shellLevel(item)])
                }
                checked={chosen.includes(item.id)}
                disabled={frozen || telegram || (locked && !bound)}
                onChange={(on) => setAgents(toggle(chosen, item.id, on))}
              />
            );
          })}
        </ListCard>
      )}
      <ConsentCard
        id={`${id}-consent`}
        stdio={stdio}
        write={write}
        agents={agentsList.filter((item) => chosen.includes(item.id))}
        navigate={navigate}
      />
      {server.auth === "oauth" && clis.length > 0 && (
        <p className="mcp-hint">{copy.connect.oauthNote}</p>
      )}
      {waiting && (
        <p role="status" className="mcp-wizard-notice">
          {copy.connect.waiting} {mcpPackageCopy.status[packageShown] ?? ""}
        </p>
      )}
      <ErrorMessage error={error} />
    </WizardStep>
  );
}

/** The wizard's Connect step (StepProps adapter). */
export default function ConnectStep({
  state,
  dispatch,
  go,
  headingRef,
  server,
  packageStatus,
  data,
  navigate,
  agentsEnabled,
  setWaiting,
}) {
  if (!server) return null;
  const finish = (results, context) => {
    dispatch({ type: "connected", results, ...context });
    dispatch({ type: "finished" });
    go("done");
  };
  return (
    <ConnectForm
      mode="new"
      server={server}
      packageShown={packageStatus.shown}
      agentsEnabled={agentsEnabled}
      write={writeSwitch(server.transport === "stdio" ? state.draft.env : [], {
        hints: state.draft.hints,
      })}
      data={data}
      navigate={navigate}
      headingRef={headingRef}
      onFinished={finish}
      onSkip={() => finish([], { diff: null, consented: false })}
      setWaiting={setWaiting}
    />
  );
}
