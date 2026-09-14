import React, { useEffect, useState } from "react";
import api from "../../lib/api.js";
import useResource from "../../lib/useResource.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import Modal from "../../components/Modal.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { remoteCopy as copy } from "../../lib/i18n/messages/remote.js";
import "./remote.css";

const RESTART_TIMEOUT = 25000;
export default function RemoteSettings() {
  const resource = useResource("/remote");
  const action = useAsyncAction();
  const [draft, setDraft] = useState(null);
  const [hostInput, setHostInput] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [notice, setNotice] = useState("");
  const [restart, setRestart] = useState(null);
  useEffect(() => {
    if (resource.data && !draft) setDraft(resource.data.network.saved);
  }, [resource.data, draft]);
  if (!resource.data || !draft)
    return <p role="status">{resource.error || copy.loading}</p>;
  const { local, tailscale, network } = resource.data;
  const locked = network.locked;
  const toggle = () => {
    setNotice("");
    if (!draft.enabled) setConfirm(true);
    else setDraft({ ...draft, enabled: false });
  };
  const addHost = () => {
    const host = hostInput.trim().toLowerCase();
    if (!host || draft.hosts.includes(host)) return;
    setNotice("");
    setDraft({ ...draft, hosts: [...draft.hosts, host] });
    setHostInput("");
  };
  const save = () =>
    action.run(async () => {
      const result = await api("/remote", "PUT", { network: draft });
      resource.update(result);
      setDraft(result.network.saved);
      setNotice(copy.saved);
    });
  const restartService = () =>
    action.run(async () => {
      const { instanceId } = await api("/remote/restart", "POST");
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
      <h2>{copy.title}</h2>
      <p>{copy.description}</p>
      <article className="settings-card">
        <h3>{copy.local}</h3>
        <p>{copy.localDescription}</p>
        <code>{local.url}</code>
      </article>
      <article className="settings-card">
        <h3>{copy.tailscale}</h3>
        <p>{copy.tailscaleDescription}</p>
        {tailscale.url ? <code>{tailscale.url}</code> : <p>{copy.tailscaleOff}</p>}
      </article>
      <article className="settings-card">
        <h3>{copy.network}</h3>
        <p>{copy.networkDescription}</p>
        <label className="switch-row">
          <input
            type="checkbox"
            role="switch"
            aria-label={copy.networkSwitch}
            checked={draft.enabled}
            onChange={toggle}
            disabled={action.busy}
          />
          {copy.networkSwitch}
        </label>
        {network.running.enabled && <p role="status">{copy.activeWarning}</p>}
        {locked && <p role="status">{copy.locked}</p>}
        {!locked && (
          <>
            <label>
              {copy.bind}
              <select
                value={draft.bind}
                onChange={(event) => {
                  setNotice("");
                  setDraft({ ...draft, bind: event.target.value });
                }}
              >
                <option value="0.0.0.0">{copy.bindAll}</option>
                <option value="::">{copy.bindAllV6}</option>
              </select>
            </label>
            <h4>{copy.hosts}</h4>
            <p>{copy.hostsDescription}</p>
            <ul className="chip-list">
              {draft.hosts.map((host) => (
                <li key={host}>
                  <span>{host}</span>
                  <button
                    type="button"
                    className="button secondary compact"
                    aria-label={copy.removeHost(host)}
                    onClick={() => {
                      setNotice("");
                      setDraft({
                        ...draft,
                        hosts: draft.hosts.filter((h) => h !== host),
                      });
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <div className="remote-form-row">
              <input
                type="text"
                aria-label={copy.hostInput}
                value={hostInput}
                onChange={(event) => setHostInput(event.target.value)}
                onKeyDown={(event) =>
                  event.key === "Enter" && (event.preventDefault(), addHost())
                }
              />
              <button type="button" className="button secondary" onClick={addHost}>
                {copy.addHost}
              </button>
            </div>
          </>
        )}
        {network.urls.length > 0 && (
          <>
            <h4>{copy.urls}</h4>
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
            {copy.save}
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
        <small>{copy.scriptHint}</small>
      </article>
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
