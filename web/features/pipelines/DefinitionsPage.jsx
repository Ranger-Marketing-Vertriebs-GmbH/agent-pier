import React, { useRef, useState } from "react";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import Icon from "../../components/Icon.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import useResource from "../../lib/useResource.js";
import useMobileLayout from "../../lib/useMobileLayout.js";
import useSettledReplace from "../projects/useSettledReplace.js";
import PipelineBuilder from "./PipelineBuilder.jsx";
import ConfirmAction from "./ConfirmAction.jsx";
import DefinitionList from "./DefinitionList.jsx";
import { pipelineRoutePath } from "./routes.js";
import "./definitions.css";

export default function DefinitionsPage({ route, navigate, refreshCounts }) {
  const definitions = useResource("/pipelines"),
    profiles = useResource("/pipeline-profiles");
  const [removing, setRemoving] = useState(null),
    [leaving, setLeaving] = useState(null),
    [resets, setResets] = useState(0),
    [dirty, setDirty] = useState(false);
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
  // Leaving an edited draft through this page asks first instead of discarding it.
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const guarded = (go) => (dirtyRef.current ? setLeaving(() => go) : go());
  const open = (id) => id !== item && guarded(() => navigate({ pipelineItem: id }));
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
    // A fresh builder starts from what was saved, so it is no longer dirty.
    setResets((value) => value + 1);
    if (item !== pipeline.id) navigate({ pipelineItem: pipeline.id });
  };
  const cancel = () => {
    if (selected) setResets((value) => value + 1);
    else navigate({ pipelineItem: "" });
  };
  const detail =
    item === "new" || selected ? (
      <PipelineBuilder
        key={`${item}:${selected?.revision ?? ""}:${resets}`}
        pipeline={selected}
        profiles={profiles.data?.profiles || []}
        saved={saved}
        cancel={cancel}
        onDirtyChange={setDirty}
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
          onClick={() =>
            item !== "new" && guarded(() => navigate({ pipelineItem: "new" }))
          }
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
            onRemove={setRemoving}
          />
        </nav>
        <div className="list-detail-detail">
          {item && (
            <button
              type="button"
              className="list-detail-back"
              onClick={() => guarded(() => navigate({ pipelineItem: "" }))}
            >
              <Icon name="back" size={16} />
              {copy.allPipelines}
            </button>
          )}
          {detail}
        </div>
      </div>
      {removing && (
        <ConfirmAction
          description={copy.deleteDefinition}
          label={commonCopy.remove}
          close={() => setRemoving(null)}
          action={async () => {
            await api(`/pipelines/${removing.id}`, "DELETE");
            setRemoving(null);
            replaceItems(items.filter((p) => p.id !== removing.id));
            refreshCounts?.();
            if (removing.id === item) navigate({ pipelineItem: "" });
          }}
        />
      )}
      {leaving && (
        <ConfirmAction
          description={copy.discardDraft}
          label={copy.discard}
          close={() => setLeaving(null)}
          action={() => {
            setLeaving(null);
            setDirty(false);
            dirtyRef.current = false;
            leaving();
          }}
        />
      )}
    </section>
  );
}
