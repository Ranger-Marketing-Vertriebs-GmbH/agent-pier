import React, { useState } from "react";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import useResource from "../../lib/useResource.js";
import useMobileLayout from "../../lib/useMobileLayout.js";
import useSettledReplace from "../projects/useSettledReplace.js";
import ProfileEditor from "./ProfileEditor.jsx";
import ProfileList, { profileGroups } from "./ProfileList.jsx";
import ConfirmAction from "./ConfirmAction.jsx";
import useDraftGuard from "./useDraftGuard.jsx";
import { pipelineRoutePath } from "./routes.js";
import "./definitions.css";
import "./profiles.css";

export default function ProfilesPage({
  route,
  navigate,
  accounts,
  onLaunchProfile,
  refreshCounts,
}) {
  const resource = useResource("/pipeline-profiles");
  const [clone, setClone] = useState(null),
    [removing, setRemoving] = useState(null),
    [resets, setResets] = useState(0);
  const mobile = useMobileLayout();
  const draft = useDraftGuard(copy.discardProfileDraft);
  const profiles = resource.data?.profiles || [],
    groups = profileGroups(profiles),
    item = route.pipelineItem,
    selected = profiles.find((p) => p.id === item),
    ready = Boolean(resource.data);
  const stats = useResource(selected ? `/pipeline-profiles/${selected.id}/stats` : null);
  // Desktop opens the first profile in phase order; mobile shows the list first.
  const target =
    ready && !item && !mobile && groups.length
      ? { ...route, pipelineItem: groups[0].items[0].id }
      : null;
  useSettledReplace({
    target,
    targetPath: target ? pipelineRoutePath(target) : "",
    currentPath: pipelineRoutePath(route),
    navigate: (next, replace) => navigate({ pipelineItem: next.pipelineItem }, replace),
  });
  const open = (id) =>
    id !== item &&
    draft.guarded(() => {
      setClone(null);
      navigate({ pipelineItem: id });
    });
  const startNew = (copied) =>
    draft.guarded(() => {
      setClone(copied);
      if (item === "new") setResets((value) => value + 1);
      else navigate({ pipelineItem: "new" });
    });
  const saved = (profile) => {
    // The saved profile keeps its place in the list; a new one is appended.
    resource.update({
      ...resource.data,
      profiles: profiles.some((p) => p.id === profile.id)
        ? profiles.map((p) => (p.id === profile.id ? profile : p))
        : [...profiles, profile],
    });
    refreshCounts?.();
    setClone(null);
    // A fresh editor starts from what was saved, so it is no longer dirty.
    setResets((value) => value + 1);
    if (item !== profile.id) navigate({ pipelineItem: profile.id });
  };
  const cancel = () => {
    if (selected) setResets((value) => value + 1);
    else {
      setClone(null);
      navigate({ pipelineItem: "" });
    }
  };
  const detail =
    item === "new" || selected ? (
      <ProfileEditor
        key={`${item}:${selected?.revision ?? ""}:${resets}`}
        profile={selected || clone}
        stats={selected ? stats.data : null}
        accounts={accounts}
        cancel={cancel}
        saved={saved}
        onDirtyChange={draft.setDirty}
        // Launching uses the saved profile, so an unsaved draft is confirmed away and
        // the editor shows the saved profile again.
        onLaunch={() =>
          draft.guarded(
            () => onLaunchProfile(selected),
            () => setResets((value) => value + 1),
          )
        }
        onDuplicate={() =>
          startNew({ ...selected, id: undefined, name: copy.copyName(selected.name) })
        }
        onRemove={() => setRemoving(selected)}
      />
    ) : (
      item && ready && <ErrorMessage error={copy.profileUnavailable} />
    );
  return (
    <section className="profiles-page">
      <div className="definitions-toolbar">
        <span>{ready ? copy.profileCount(profiles.length) : ""}</span>
        <div className="pipeline-actions">
          <button
            type="button"
            className="button secondary" // A reload remounts the editor, so an unsaved draft is confirmed first.
            onClick={() => draft.guarded(resource.refresh)}
          >
            {commonCopy.refresh}
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => (item !== "new" || clone) && startNew(null)}
          >
            <Icon name="plus" size={16} />
            {copy.newProfile}
          </button>
        </div>
      </div>
      <ErrorMessage error={resource.error} />
      {resource.loading && !ready && <p role="status">{copy.loading}</p>}
      <div className={`list-detail profiles-layout${item ? " has-detail" : ""}`}>
        <nav className="list-detail-list" aria-label={copy.profiles}>
          {ready && !profiles.length && (
            <p className="definitions-empty">{copy.noProfiles}</p>
          )}
          <ProfileList groups={groups} selectedId={item} onSelect={open} />
        </nav>
        <div className="list-detail-detail">
          {item && (
            <button
              type="button"
              className="list-detail-back"
              onClick={() =>
                draft.guarded(() => {
                  setClone(null);
                  navigate({ pipelineItem: "" });
                })
              }
            >
              <Icon name="back" size={16} />
              {copy.allProfiles}
            </button>
          )}
          {detail}
        </div>
      </div>
      {removing && (
        <ConfirmAction
          description={copy.deleteProfile}
          label={commonCopy.remove}
          close={() => setRemoving(null)}
          action={async () => {
            await api(`/pipeline-profiles/${removing.id}`, "DELETE");
            setRemoving(null);
            resource.update({
              ...resource.data,
              profiles: profiles.filter((p) => p.id !== removing.id),
            });
            refreshCounts?.();
            // A removed profile has no unsaved draft left to protect.
            draft.setDirty(false);
            if (removing.id === item) navigate({ pipelineItem: "" });
          }}
        />
      )}
      {draft.confirm}
    </section>
  );
}
