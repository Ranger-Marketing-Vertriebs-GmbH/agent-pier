import React, { useState } from "react";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import useResource from "../../lib/useResource.js";
import ProfileEditor from "./ProfileEditor.jsx";
import ProfileLaunch from "./ProfileLaunch.jsx";
import ConfirmAction from "./ConfirmAction.jsx";
export default function ProfilesPage({ route, navigate, accounts, home, onSession }) {
  const resource = useResource("/pipeline-profiles");
  const [clone, setClone] = useState(null),
    [removing, setRemoving] = useState(null),
    [launching, setLaunching] = useState(null);
  const profiles = resource.data?.profiles || [],
    item = route.pipelineItem,
    selected = profiles.find((p) => p.id === item);
  const stats = useResource(selected ? `/pipeline-profiles/${selected.id}/stats` : null);
  const close = () => {
    setClone(null);
    navigate({ pipelineItem: "" });
  };
  return (
    <section>
      <div className="pipeline-toolbar">
        <h2>{copy.profiles}</h2>
        <button
          className="button primary"
          onClick={() => {
            setClone(null);
            navigate({ pipelineItem: "new" });
          }}
        >
          {copy.newProfile}
        </button>
        <button className="button secondary" onClick={resource.refresh}>
          {commonCopy.refresh}
        </button>
      </div>
      <ErrorMessage error={resource.error} />
      {resource.loading && <p role="status">{copy.loading}</p>}
      {!resource.loading && !profiles.length && <p>{copy.noProfiles}</p>}
      {Object.entries(copy.phaseNames).map(([phase, label]) => {
        const rows = profiles.filter((p) => (p.phaseKey || "custom") === phase);
        return rows.length ? (
          <section key={phase} className="pipeline-group">
            <h3>{label}</h3>
            {rows.map((profile) => (
              <article key={profile.id} className="pipeline-card">
                <div>
                  <h3>{profile.name}</h3>
                  <p>{profile.description}</p>
                  <small>
                    {profile.config.cliTool} ·{" "}
                    {profile.config.run.autonomous ? copy.autonomous : copy.interactive} ·{" "}
                    {profile.config.permissions.mode}
                    {profile.enabled ? "" : ` · ${commonCopy.disabled}`}
                  </small>
                </div>
                <div className="pipeline-actions">
                  <button
                    className="button secondary compact"
                    aria-label={copy.edit(profile.name)}
                    onClick={() => navigate({ pipelineItem: profile.id })}
                  >
                    {copy.editLabel}
                  </button>
                  <button
                    className="button secondary compact"
                    aria-label={copy.clone(profile.name)}
                    onClick={() => {
                      setClone({
                        ...profile,
                        id: undefined,
                        name: copy.copyName(profile.name),
                      });
                      navigate({ pipelineItem: "new" });
                    }}
                  >
                    {copy.clone(profile.name)}
                  </button>
                  <button
                    className="button secondary compact"
                    disabled={!profile.enabled}
                    onClick={() => setLaunching(profile)}
                  >
                    {copy.startProfile}
                  </button>
                  <button
                    className="button secondary compact"
                    aria-label={copy.remove(profile.name)}
                    onClick={() => setRemoving(profile)}
                  >
                    {commonCopy.remove}
                  </button>
                </div>
              </article>
            ))}
          </section>
        ) : null;
      })}
      {item && item !== "new" && !selected && !resource.loading && (
        <ErrorMessage error={copy.profileUnavailable} />
      )}{" "}
      {(item === "new" || selected) && (
        <ProfileEditor
          key={item + (clone?.name || "")}
          profile={selected || clone}
          stats={stats.data}
          accounts={accounts}
          close={close}
          saved={() => {
            resource.refresh();
            close();
          }}
        />
      )}
      {removing && (
        <ConfirmAction
          description={copy.deleteProfile}
          label={commonCopy.remove}
          close={() => setRemoving(null)}
          action={async () => {
            await api(`/pipeline-profiles/${removing.id}`, "DELETE");
            setRemoving(null);
            resource.refresh();
          }}
        />
      )}
      {launching && (
        <ProfileLaunch
          profile={launching}
          home={home}
          close={() => setLaunching(null)}
          started={onSession}
        />
      )}
    </section>
  );
}
