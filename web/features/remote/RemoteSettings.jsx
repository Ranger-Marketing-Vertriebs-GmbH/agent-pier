import React, { useEffect, useState } from "react";
import api from "../../lib/api.js";
import useResource from "../../lib/useResource.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import ListCard from "../../components/ListCard.jsx";
import { SelectRow } from "../../components/ListRow.jsx";
import Switch from "../../components/Switch.jsx";
import NetworkHosts from "./NetworkHosts.jsx";
import PreviewSettingsCard from "../previews/PreviewSettingsCard.jsx";
import { remoteCopy as copy } from "../../lib/i18n/messages/remote.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { formatMessageTime } from "../../lib/i18n/index.js";
import "./remote.css";

const RESTART_TIMEOUT = 25000;
export default function RemoteSettings() {
  const resource = useResource("/remote");
  const action = useAsyncAction();
  const [draft, setDraft] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState("");
  const [restart, setRestart] = useState(null);
  useEffect(() => {
    if (resource.data && !draft) setDraft(resource.data.network.saved);
  }, [resource.data, draft]);
  if (!resource.data || !draft)
    return <p role="status">{resource.error || copy.loading}</p>;
  const { local, tailscale, network } = resource.data;
  // Hosts that agent hook requests named but AgentPier does not accept (after a move).
  const refusedHosts = resource.data.hooks?.refusedHosts || [];
  const locked = network.locked;
  const toggle = () => {
    setNotice("");
    if (!draft.enabled) setConfirm(true);
    else setDraft({ ...draft, enabled: false });
  };
  const save = () =>
    action.run(async () => {
      setRestart(null);
      const result = await api("/remote", "PUT", { network: draft });
      resource.update(result);
      setDraft(result.network.saved);
      setNotice(copy.saved);
    });
  const restartService = () =>
    action.run(async () => {
      setRestart(null);
      const { instanceId } = await api("/remote/restart", "POST");
      // Switching the mode off through this very connection: nothing will answer here again.
      if (locked && !network.saved.enabled) return setRestart("disconnected");
      setRestart("running");
      const deadline = Date.now() + RESTART_TIMEOUT;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          const health = await api("/health");
          if (health.instanceId !== instanceId) {
            setRestart("done");
            resource.update(await api("/remote"));
            return;
          }
        } catch {}
      }
      setRestart("failed");
    });
  return (
    <section className="page operations-page remote-settings" aria-label={copy.title}>
      <p>{copy.description}</p>
      <article className="settings-card">
        <h2>{copy.local}</h2>
        <p>{copy.localDescription}</p>
        <code>{local.url}</code>
      </article>
      <article className="settings-card">
        <h2>{copy.tailscale}</h2>
        <p>{copy.tailscaleDescription}</p>
        {tailscale.url ? <code>{tailscale.url}</code> : <p>{copy.tailscaleOff}</p>}
      </article>
      {refusedHosts.length > 0 && (
        <article className="settings-card" data-hook-refused-hosts>
          <h2>{copy.hookHosts}</h2>
          <p role="status">{copy.hookHostsDescription}</p>
          <ul>
            {refusedHosts.map((entry) => (
              <li key={entry.host}>
                <code>{entry.host}</code>{" "}
                {copy.hookHostSeen(entry.count, formatMessageTime(entry.at))}
              </li>
            ))}
          </ul>
        </article>
      )}
      <article className="settings-card">
        <h2>{copy.network}</h2>
        <p>{copy.networkDescription}</p>
        <Switch
          label={copy.networkSwitch}
          checked={draft.enabled}
          onChange={toggle}
          disabled={action.busy}
        />
        {network.running.enabled && <p role="status">{copy.activeWarning}</p>}
        {locked && <p role="status">{copy.locked}</p>}
        {!locked && (
          <>
            <ListCard label={copy.network}>
              <SelectRow
                label={copy.bind}
                value={draft.bind}
                disabled={action.busy}
                onChange={(bind) => {
                  setNotice("");
                  setDraft({ ...draft, bind });
                }}
                options={[
                  { value: "0.0.0.0", label: copy.bindAll },
                  { value: "::", label: copy.bindAllV6 },
                ]}
              />
            </ListCard>
            <NetworkHosts
              hosts={draft.hosts}
              disabled={action.busy}
              onChange={(hosts) => {
                setNotice("");
                setDraft({ ...draft, hosts });
              }}
            />
          </>
        )}
        {network.urls.length > 0 && (
          <>
            <h3>{copy.urls}</h3>
            <ul>
              {network.urls.map((url) => (
                <li key={url}>
                  <code>{url}</code>
                </li>
              ))}
            </ul>
          </>
        )}
        <ErrorMessage error={action.error} />
        {notice && <p role="status">{notice}</p>}
        {network.restartRequired && <p role="status">{copy.restartRequired}</p>}
        <div className="operations-actions">
          <button
            type="button"
            className="button primary"
            disabled={action.busy}
            onClick={save}
          >
            {commonCopy.save}
          </button>
          {network.restartRequired && (
            <button
              type="button"
              className="button secondary"
              disabled={action.busy}
              onClick={restartService}
            >
              {copy.restart}
            </button>
          )}
        </div>
        {restart === "running" && <p role="status">{copy.restarting}</p>}
        {restart === "done" && <p role="status">{copy.restarted}</p>}
        {restart === "failed" && <p role="alert">{copy.restartFailed}</p>}
        {restart === "disconnected" && <p role="status">{copy.disconnected}</p>}
        <small>{copy.scriptHint}</small>
      </article>
      <PreviewSettingsCard locked={locked} />
      {confirm && (
        <Modal title={copy.warningTitle} close={() => setConfirm(false)}>
          <div className="operations-form">
            <p role="alert">{copy.warning}</p>
            <div className="operations-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setConfirm(false)}
              >
                {copy.warningCancel}
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() => {
                  setNotice("");
                  setDraft({ ...draft, enabled: true });
                  setConfirm(false);
                }}
              >
                {copy.warningConfirm}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
