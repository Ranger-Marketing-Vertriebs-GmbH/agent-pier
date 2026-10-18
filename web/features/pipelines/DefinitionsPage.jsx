import React, { useState } from "react";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import useResource from "../../lib/useResource.js";
import useMobileLayout from "../../lib/useMobileLayout.js";
import useSettledReplace from "../../lib/useSettledReplace.js";
import PipelineBuilder from "./PipelineBuilder.jsx";
import ConfirmDialog from "../../components/ConfirmDialog.jsx";
import DefinitionList from "./DefinitionList.jsx";
import useDraftGuard from "./useDraftGuard.jsx";
import { pipelineRoutePath } from "./routes.js";
import "./definitions.css";

export default function DefinitionsPage({ route, navigate, refreshCounts }) {
  const definitions = useResource("/pipelines"),
    profiles = useResource("/pipeline-profiles");
  const [removing, setRemoving] = useState(null),
    [clone, setClone] = useState(null),
    [resets, setResets] = useState(0);
  // Leaving an edited draft through this page asks first instead of discarding it.
  const { guarded, setDirty, setSave, confirm } = useDraftGuard(copy.discardDraft, route);
  const mobile = useMobileLayout();
  const items = definitions.data?.pipelines || [],
    item = route.pipelineItem,
    selected = items.find((p) => p.id === item),
    ready = Boolean(definitions.data);
  // Desktop opens the first pipeline; mobile shows the list first.
  const target =
    ready && !item && !mobile && items.length
      ? { ...route, pipelineItem: items[0].id }
      : null;
  useSettledReplace({
    target,
    targetPath: target ? pipelineRoutePath(target) : "",
    currentPath: pipelineRoutePath(route),
    navigate: (next, replace) => navigate({ pipelineItem: next.pipelineItem }, replace),
  });
  const open = (id) =>
    id !== item &&
    guarded(() => {
      setClone(null);
      navigate({ pipelineItem: id });
    });
  // A new pipeline, empty or prefilled from `copied`.
  const startNew = (copied) =>
    guarded(() => {
      setClone(copied);
      if (item === "new") setResets((value) => value + 1);
      else navigate({ pipelineItem: "new" });
    });
  const replaceItems = (pipelines) =>
    definitions.update({ ...definitions.data, pipelines });
  const saved = (pipeline) => {
    // The saved pipeline keeps its place in the list; a new one is appended.
    replaceItems(
      items.some((p) => p.id === pipeline.id)
        ? items.map((p) => (p.id === pipeline.id ? pipeline : p))
        : [...items, pipeline],
    );
    refreshCounts?.();
    setClone(null);
    // A fresh builder starts from what was saved, so it is no longer dirty.
    setResets((value) => value + 1);
    if (item !== pipeline.id) navigate({ pipelineItem: pipeline.id });
  };
  const cancel = () => {
    setDirty(false);
    if (selected) setResets((value) => value + 1);
    else {
      setClone(null);
      navigate({ pipelineItem: "" });
    }
  };
  const detail =
    item === "new" || selected ? (
      <PipelineBuilder
        key={`${item}:${selected?.revision ?? ""}:${resets}`}
        pipeline={selected}
        template={selected ? null : clone}
        profiles={profiles.data?.profiles || []}
        saved={saved}
        cancel={cancel}
        onDirtyChange={setDirty}
        onSaver={setSave}
      />
    ) : (
      item && ready && <ErrorMessage error={copy.definitionUnavailable} />
    );
  return (
    <section className="definitions-page">
      <div className="definitions-toolbar">
        <span>{ready ? copy.pipelineCount(items.length) : ""}</span>
        <button
          type="button"
          className="button primary"
          onClick={() => (item !== "new" || clone) && startNew(null)}
        >
          <Icon name="plus" size={16} />
          {copy.newPipeline}
        </button>
      </div>
      <ErrorMessage error={definitions.error || profiles.error} />
      {definitions.loading && !ready && <p role="status">{copy.loading}</p>}
      <div className={`list-detail definitions-layout${item ? " has-detail" : ""}`}>
        <nav className="list-detail-list" aria-label={copy.definitions}>
          {ready && !items.length && (
            <p className="definitions-empty">{copy.noDefinitions}</p>
          )}
          <DefinitionList
            items={items}
            selectedId={item}
            onSelect={open}
            onRun={(id) =>
              guarded(() =>
                navigate({
                  pipelineTab: "runs",
                  pipelineItem: "new",
                  selectedPipeline: id,
                }),
              )
            }
            onDuplicate={(pipeline) =>
              startNew({
                name: copy.copyName(pipeline.name),
                description: pipeline.description,
                graph: pipeline.graph,
              })
            }
            onRemove={setRemoving}
          />
        </nav>
        <div className="list-detail-detail">
          {item && (
            <button
              type="button"
              className="list-detail-back"
              onClick={() =>
                guarded(() => {
                  setClone(null);
                  navigate({ pipelineItem: "" });
                })
              }
            >
              <Icon name="back" size={16} />
              {copy.allPipelines}
            </button>
          )}
          {detail}
        </div>
      </div>
      {removing && (
        <ConfirmDialog
          destructive
          title={copy.confirmTitles.definition(removing.name)}
          body={copy.deleteDefinition}
          confirmLabel={copy.confirmLabels.definition}
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            await api(`/pipelines/${removing.id}`, "DELETE");
            setRemoving(null);
            replaceItems(items.filter((p) => p.id !== removing.id));
            refreshCounts?.();
            if (removing.id === item) {
              // A removed pipeline has no unsaved draft left to protect.
              setDirty(false);
              navigate({ pipelineItem: "" });
            }
          }}
        />
      )}
      {confirm}
    </section>
  );
}
