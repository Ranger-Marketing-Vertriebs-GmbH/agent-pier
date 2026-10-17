import React, { useEffect, useId, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { mcpPackageCopy as copy } from "../../lib/i18n/messages/mcp-packages.js";
import useLanguage from "../../lib/i18n/useLanguage.js";
import { names as toolNames } from "../../lib/providers.js";
import { assistantApi } from "../assistants/assistant-api.js";

const profileName = (profiles, id) => {
  const profile = profiles.find((item) => item.id === id);
  return profile ? toolNames[profile.tool] || profile.tool : id;
};

/**
 * The skills an installed package bundles (docs/mcp.md). The owner reviews a skill's
 * description and files, picks one CLI profile and confirms the copy; AgentPier then
 * updates the copy with the package and removes it with the package. Renders nothing
 * until the package is ready or when it ships no skill.
 */
export default function McpPackageSkills({ serverId, ready, version }) {
  useLanguage();
  const id = useId();
  const [data, setData] = useState(null);
  const [profileId, setProfileId] = useState("");
  const [picked, setPicked] = useState([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!ready) return undefined;
    let live = true;
    assistantApi
      .mcpPackageSkills(serverId)
      .then((next) => live && setData(next))
      .catch((failure) => live && setError(failure.message));
    return () => {
      live = false;
    };
  }, [serverId, ready, version]);
  if (!ready || !data?.skills?.length)
    return error ? <ErrorMessage error={error} /> : null;
  const profiles = data.profiles || [];
  const profile = profiles.some((item) => item.id === profileId)
    ? profileId
    : profiles[0]?.id || "";
  const installedHere = (skill) =>
    skill.installed.some((entry) => entry.profileId === profile);
  const chosen = data.skills.filter(
    (skill) => picked.includes(skill.name) && !installedHere(skill),
  );
  const install = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setData(
        await assistantApi.installMcpPackageSkills(serverId, {
          profileId: profile,
          names: chosen.map((skill) => skill.name),
          confirmInstall: true,
        }),
      );
      setPicked([]);
      setConfirming(false);
      setNotice(copy.skills.installedNotice);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="mcp-package-skills" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>{copy.skills.title}</h4>
      <p className="mcp-hint">{copy.skills.hint}</p>
      <ul className="mcp-package-skill-list">
        {data.skills.map((skill) => (
          <li key={skill.name}>
            <label className="mcp-check">
              <input
                type="checkbox"
                disabled={busy || confirming || installedHere(skill)}
                checked={installedHere(skill) || picked.includes(skill.name)}
                onChange={(event) =>
                  setPicked((current) =>
                    event.target.checked
                      ? [...current, skill.name]
                      : current.filter((name) => name !== skill.name),
                  )
                }
              />
              <strong>{skill.name}</strong>
            </label>
            <p>{skill.description}</p>
            {skill.installed.length > 0 && (
              <p className="mcp-hint">
                {copy.skills.installedIn(
                  skill.installed
                    .map((entry) =>
                      copy.skills.installedAt(
                        profileName(profiles, entry.profileId),
                        entry.version,
                      ),
                    )
                    .join(", "),
                )}
              </p>
            )}
            <details>
              <summary>{copy.files(skill.files.length)}</summary>
              <ul className="mcp-package-skill-files">
                {skill.files.map((file) => (
                  <li key={file}>
                    <code>{file}</code>
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ul>
      <div className="mcp-field">
        <label htmlFor={`${id}-profile`}>{copy.skills.profileLabel}</label>
        <select
          id={`${id}-profile`}
          value={profile}
          disabled={busy || confirming}
          onChange={(event) => setProfileId(event.target.value)}
        >
          {profiles.map((item) => (
            <option key={item.id} value={item.id}>
              {toolNames[item.tool] || item.tool}
            </option>
          ))}
        </select>
      </div>
      <ErrorMessage error={error} />
      {notice && <p role="status">{notice}</p>}
      {confirming ? (
        <div
          className="mcp-package-update"
          role="group"
          aria-label={copy.skills.confirmTitle}
        >
          <p>
            <strong>
              {copy.skills.confirmText(
                chosen.map((skill) => skill.name).join(", "),
                profileName(profiles, profile),
              )}
            </strong>
          </p>
          <p className="mcp-warning">{copy.skills.untrusted}</p>
          <div className="mcp-actions">
            <button
              type="button"
              className="button primary"
              disabled={busy || !chosen.length}
              onClick={install}
            >
              {copy.skills.confirm}
            </button>
            <button
              type="button"
              className="button text"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              {copy.skills.cancel}
            </button>
          </div>
        </div>
      ) : (
        <div className="mcp-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy || !chosen.length || !profile}
            onClick={() => {
              setNotice("");
              setConfirming(true);
            }}
          >
            {copy.skills.install}
          </button>
        </div>
      )}
    </section>
  );
}
