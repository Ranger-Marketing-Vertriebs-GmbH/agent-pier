import React, { useState } from "react";
import api from "../../lib/api.js";
import useAsyncAction from "../../lib/useAsyncAction.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
import { commonCopy } from "../../lib/i18n/messages/common.js";
import StageCards from "./StageCards.jsx";
import { graphToStages, stagesToGraph, stageError } from "./graph-editor.js";
export default function PipelineBuilder({ pipeline, profiles, saved, cancel }) {
  const initial = graphToStages(pipeline?.graph);
  const [name, setName] = useState(pipeline?.name || ""),
    [description, setDescription] = useState(pipeline?.description || ""),
    [stages, setStages] = useState(initial || []),
    [advanced, setAdvanced] = useState(Boolean(pipeline && !initial)),
    [json, setJson] = useState(
      JSON.stringify(pipeline?.graph || { entry: "", nodes: [], edges: [] }, null, 2),
    ),
    [error, setError] = useState("");
  const action = useAsyncAction();
  const switchMode = () => {
    if (advanced) {
      try {
        const next = graphToStages(JSON.parse(json));
        if (!next) {
          setError(copy.nonlinear);
          return;
        }
        setStages(next);
        setAdvanced(false);
        setError("");
      } catch {
        setError(copy.invalidGraph);
      }
    } else {
      setJson(JSON.stringify(stagesToGraph(stages), null, 2));
      setAdvanced(true);
      setError("");
    }
  };
  return (
    <form
      className="pipeline-form"
      onSubmit={(event) => {
        event.preventDefault();
        action.run(async () => {
          let graph;
          try {
            graph = advanced ? JSON.parse(json) : stagesToGraph(stages);
          } catch {
            throw Error(copy.invalidGraph);
          }
          if (!advanced) {
            const invalid = stageError(stages, copy);
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
      }}
    >
      <fieldset disabled={action.busy}>
        <label>
          {copy.pipelineName}
          <input
            required
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          {copy.descriptionLabel}
          <textarea
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <button type="button" className="button secondary" onClick={switchMode}>
          {advanced ? copy.cards : copy.advanced}
        </button>
        {advanced ? (
          <>
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
          </>
        ) : (
          <StageCards
            disabled={action.busy}
            stages={stages}
            setStages={setStages}
            profiles={profiles.filter(
              (p) =>
                p.enabled &&
                p.config.run.autonomous &&
                !p.config.prompts.params.some((param) => param.required),
            )}
          />
        )}
      </fieldset>
      <ErrorMessage error={error || action.error} />
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
    </form>
  );
}
