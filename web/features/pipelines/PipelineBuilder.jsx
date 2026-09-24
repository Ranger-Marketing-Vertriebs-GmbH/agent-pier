import React, { useEffect, useState } from "react";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { browserUuid } from "../../lib/browser-uuid.js";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import StageFlow from "./StageFlow.jsx";
import StageEditor from "./StageEditor.jsx";
import { graphToStages, stagesToGraph, stageError } from "./graph-editor.js";

const eligible = (profiles) =>
  profiles.filter(
    (p) =>
      p.enabled &&
      p.config.run.autonomous &&
      !p.config.prompts.params.some((param) => param.required),
  );
const formatGraph = (graph) => JSON.stringify(graph, null, 2);
// The draft as it would be saved; the view toggle alone never makes it dirty.
const draftSnapshot = (name, description, advanced, json, stages) =>
  JSON.stringify([
    name,
    description,
    advanced ? json : formatGraph(stagesToGraph(stages)),
  ]);

function useStageDraft(initial) {
  const [stages, updateStages] = useState(initial || []),
    [selectedKey, setSelectedKey] = useState(initial?.[0]?.key || ""),
    [notice, setNotice] = useState("");
  const found = stages.findIndex((s) => s.key === selectedKey);
  const selected = found >= 0 ? found : 0;
  // Every edit replaces a notice left by the previous one.
  const setStages = (next) => {
    setNotice("");
    updateStages(next);
  };
  return {
    stages,
    setStages,
    selected,
    notice,
    clearNotice: () => setNotice(""),
    select: (index) => setSelectedKey(stages[index]?.key || ""),
    add: () => {
      const key = `stage-${browserUuid()}`;
      setStages([
        ...stages,
        {
          key,
          profileId: "",
          gate: false,
          verify: false,
          createPr: false,
          loopBackTo: "",
          maxIterations: 2,
        },
      ]);
      setSelectedKey(key);
    },
    move: (index, delta) => {
      const next = [...stages];
      [next[index], next[index + delta]] = [next[index + delta], next[index]];
      // A loop may only return to an earlier stage; one that no longer does is
      // dropped, and the notice says so.
      const dropped = [];
      const valid = next.map((stage, i) => {
        if (!stage.loopBackTo || next.slice(0, i).some((s) => s.key === stage.loopBackTo))
          return stage;
        dropped.push(i + 1);
        return { ...stage, loopBackTo: "" };
      });
      setStages(valid);
      if (dropped.length) setNotice(copy.loopDropped(dropped[0]));
    },
    remove: (index) => {
      const removed = stages[index].key;
      const next = stages
        .filter((_, i) => i !== index)
        .map((s) => (s.loopBackTo === removed ? { ...s, loopBackTo: "" } : s));
      setStages(next);
      setSelectedKey(next[Math.max(0, index - 1)]?.key || "");
    },
  };
}

export default function PipelineBuilder({
  pipeline,
  profiles,
  saved,
  cancel,
  onDirtyChange,
}) {
  const initial = graphToStages(pipeline?.graph);
  const draft = useStageDraft(initial);
  const [name, setName] = useState(pipeline?.name || ""),
    [description, setDescription] = useState(pipeline?.description || ""),
    [advanced, setAdvanced] = useState(Boolean(pipeline && !initial)),
    [json, setJson] = useState(
      formatGraph(pipeline?.graph || { entry: "", nodes: [], edges: [] }),
    ),
    [error, setError] = useState("");
  const [baseline] = useState(() =>
    draftSnapshot(name, description, advanced, json, draft.stages),
  );
  const dirty =
    draftSnapshot(name, description, advanced, json, draft.stages) !== baseline;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const action = useAsyncAction();
  const switchMode = () => {
    if (advanced) {
      try {
        const next = graphToStages(JSON.parse(json));
        if (!next) {
          setError(copy.nonlinear);
          return;
        }
        draft.setStages(next);
        setAdvanced(false);
        setError("");
      } catch {
        setError(copy.invalidGraph);
      }
    } else {
      setJson(formatGraph(stagesToGraph(draft.stages)));
      setAdvanced(true);
      setError("");
    }
  };
  const submit = (event) => {
    event.preventDefault();
    action.run(async () => {
      let graph;
      try {
        graph = advanced ? JSON.parse(json) : stagesToGraph(draft.stages);
      } catch {
        throw Error(copy.invalidGraph);
      }
      if (!advanced) {
        const invalid = stageError(draft.stages, copy);
        if (invalid) throw Error(invalid);
      }
      const result = await api(
        "/pipelines" + (pipeline ? "/" + pipeline.id : ""),
        pipeline ? "PATCH" : "POST",
        {
          name,
          description,
          graph,
          ...(pipeline ? { expectedRevision: pipeline.revision } : {}),
        },
      );
      saved(result.pipeline);
    });
  };
  const stageProfiles = eligible(profiles);
  return (
    <form className="pipeline-form definition-card" onSubmit={submit}>
      <fieldset disabled={action.busy}>
        <div className="definition-head">
          <label>
            {copy.pipelineName}
            <input
              required
              maxLength={200}
              value={name}
              onChange={(event) => {
                draft.clearNotice();
                setName(event.target.value);
              }}
            />
          </label>
          <label>
            {copy.descriptionLabel}
            <textarea
              rows={1}
              value={description}
              onChange={(event) => {
                draft.clearNotice();
                setDescription(event.target.value);
              }}
            />
          </label>
        </div>
        {advanced ? (
          <div className="definition-json">
            <p className="field-description">{copy.nonlinear}</p>
            <label>
              {copy.graph}
              <textarea
                aria-label={copy.graph}
                className="pipeline-json"
                value={json}
                onChange={(event) => setJson(event.target.value)}
              />
            </label>
          </div>
        ) : (
          <>
            <StageFlow
              stages={draft.stages}
              profiles={profiles}
              selected={draft.selected}
              onSelect={draft.select}
              onAdd={draft.add}
            />
            {draft.stages.length > 0 && (
              <StageEditor
                key={draft.stages[draft.selected].key}
                stages={draft.stages}
                index={draft.selected}
                profiles={stageProfiles}
                setStages={draft.setStages}
                onMove={draft.move}
                onRemove={draft.remove}
                disabled={action.busy}
              />
            )}
            {draft.notice && (
              <p className="stage-notice" role="status">
                {draft.notice}
              </p>
            )}
          </>
        )}
      </fieldset>
      <ErrorMessage error={error || action.error} />
      <div className="definition-footer">
        <button
          type="button"
          className="definition-mode"
          onClick={switchMode}
          disabled={action.busy}
        >
          {advanced ? copy.cards : copy.advanced}
        </button>
        <div className="pipeline-actions">
          <button
            type="button"
            className="button secondary"
            onClick={cancel}
            disabled={action.busy}
          >
            {commonCopy.cancel}
          </button>
          <button className="button primary" disabled={action.busy}>
            {commonCopy.save}
          </button>
        </div>
      </div>
    </form>
  );
}
