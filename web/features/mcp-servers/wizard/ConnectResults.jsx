import React, { useState } from "react";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";
import { connectApi } from "./connect-api.js";
import { AGENT_GONE, onlyTarget, PACKAGE_NOT_READY, runConnect } from "./connect-plan.js";

const reason = (error) =>
  error?.code === AGENT_GONE
    ? copy.done.agentGone
    : error?.code === PACKAGE_NOT_READY
      ? copy.done.packageNotReady
      : error?.message || "";
const sameTarget = (a, b) => a.kind === b.kind && a.id === b.id;

/**
 * One line per agent and, when the CLI update itself failed, its reason; a failed
 * target offers Try again for that target only (decision Q2).
 */
export default function ConnectResults({
  results,
  diff,
  consented,
  serverId,
  data,
  onChange,
}) {
  const [busy, setBusy] = useState(null);
  const retry = async (target) => {
    setBusy(target);
    try {
      const [result] = await runConnect({
        diff: onlyTarget(diff, target),
        serverId,
        consented,
        api: connectApi(data),
      });
      // The retry is applied; a failed refresh must not hide its result.
      await data.reloadMcp().catch(() => {});
      if (result)
        onChange(
          results.map((item) => (sameTarget(item.target, target) ? result : item)),
        );
    } finally {
      setBusy(null);
    }
  };
  const retryButton = (result) =>
    diff &&
    result.error?.code !== PACKAGE_NOT_READY && (
      <button
        type="button"
        className="button secondary compact"
        disabled={Boolean(busy)}
        onClick={() => retry(result.target)}
      >
        {copy.done.tryAgain}
      </button>
    );
  const cli = results.find((item) => item.target.kind === "cli" && !item.ok);
  const agents = results.filter((item) => item.target.kind === "agent");
  return (
    <>
      {cli && (
        <p className="mcp-field-error" role="alert">
          {copy.done.cliFailed(reason(cli.error))} {retryButton(cli)}
        </p>
      )}
      {agents.length > 0 && (
        <section className="mcp-wizard-card-block" aria-label={copy.done.agents}>
          <h2 className="mcp-wizard-subtitle">{copy.done.agents}</h2>
          <ul className="mcp-wizard-results" aria-live="polite">
            {agents.map((item) => (
              <li key={item.target.id} className={item.ok ? "" : "is-failed"}>
                <span>
                  {item.ok
                    ? (item.target.add
                        ? copy.done.agentConnected
                        : copy.done.agentRemoved)(item.target.name)
                    : copy.done.agentFailed(item.target.name, reason(item.error))}
                </span>{" "}
                {!item.ok && retryButton(item)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
