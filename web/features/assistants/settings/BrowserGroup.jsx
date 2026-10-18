import React, { useEffect, useId, useState } from "react";
import GroupLabel from "../../../components/GroupLabel.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow, { ToggleRow } from "../../../components/ListRow.jsx";
import Sheet from "../../../components/Sheet.jsx";
import { assistantBrowserCopy as copy } from "../../../lib/i18n/messages/assistant-browser.js";
import { assistantApi } from "../assistant-api.js";
import { shellEligible } from "../shell-level.js";
import { isPersonal } from "./agent-settings-fields.js";
import BrowserInstall from "./BrowserInstall.jsx";
import { routePath } from "../../../app/routes.js";
import { commonCopy } from "../../../lib/i18n/messages/common.js";

/**
 * The agent's own browser (docs/assistant-gateway.md "Browser isolation"): the
 * visible window, whether it runs and resetting its persistent profile. Shown while
 * the browser switch is on; the window needs a separate agent browser app.
 */
export default function BrowserGroup({ assistant, draft, browser, refresh, navigate }) {
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState("");
  // An archived agent keeps its profile (archiving can be undone) and may reset it,
  // as long as a profile is stored.
  const archived = Boolean(assistant?.archivedAt);
  const [stored, setStored] = useState(false);
  const agentId = assistant?.id;
  useEffect(() => {
    if (!archived || !agentId) return undefined;
    const controller = new AbortController();
    assistantApi
      .browserStatus(agentId, controller.signal)
      .then((status) => setStored(status?.stored === true))
      .catch(() => {});
    return () => controller.abort();
  }, [archived, agentId]);
  if (!assistant || !isPersonal(assistant)) return null;
  if (archived && !stored && !result) return null;
  if (!archived && (!shellEligible(assistant) || draft.values.browser !== true))
    return null;
  const liveRoute = { view: "agents", assistantId: assistant.id, agentBrowser: true };
  const window = browser?.visible;
  const reason = window && !window.available ? copy[window.reason] || copy.noApp : "";
  const on = draft.values.browserVisible === true;
  const reset = async () => {
    setConfirming(false);
    try {
      await assistantApi.browserReset(assistant.id);
      setResult(copy.resetDone);
      if (archived) setStored(false);
    } catch {
      setResult(copy.resetFailed);
    }
  };
  return (
    <section aria-labelledby={id}>
      <GroupLabel id={id} hint={copy.profile}>
        {copy.group}
      </GroupLabel>
      <ListCard labelledBy={id}>
        {!archived && (
          <ToggleRow
            label={copy.visible}
            sub={reason || copy.visibleDescription}
            checked={on}
            // A switched-on window can always be turned off.
            disabled={draft.saving || (Boolean(reason) && !on)}
            onChange={(next) => draft.set("browserVisible", next)}
          />
        )}
        {!archived && <BrowserInstall browser={browser} refresh={refresh} />}
        {!archived && (
          <ListRow
            label={copy.liveOpen}
            sub={copy.liveOpenDescription}
            href={routePath(liveRoute)}
            onClick={() => navigate?.(liveRoute)}
          />
        )}
        {assistant.browserRunning && (
          <ListRow label={copy.running} status={{ tone: "ok", text: copy.runningNow }} />
        )}
        {(!archived || stored) && (
          <ListRow
            label={copy.reset}
            sub={copy.resetDescription}
            onClick={() => setConfirming(true)}
          />
        )}
      </ListCard>
      {result && (
        <p role="status" className="assistant-notice">
          {result}
        </p>
      )}
      {confirming && (
        <Sheet
          open
          title={copy.resetTitle}
          onCancel={() => setConfirming(false)}
          className="agent-confirmation-sheet"
        >
          <div className="sheet-body">
            <p>{copy.resetDescription}</p>
          </div>
          <div className="sheet-actions">
            <button type="button" className="button primary" onClick={reset}>
              {copy.resetConfirm}
            </button>
            <button
              type="button"
              className="button secondary"
              autoFocus
              onClick={() => setConfirming(false)}
            >
              {commonCopy.cancel}
            </button>
          </div>
        </Sheet>
      )}
    </section>
  );
}
