import React, { useState } from "react";
import api from "../../lib/api.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { pipelineCopy as copy } from "../../lib/i18n/de/pipelines.js";
import { commonCopy } from "../../lib/i18n/de/common.js";
import useResource from "../../lib/useResource.js";
import PipelineBuilder from "./PipelineBuilder.jsx";
import ConfirmAction from "./ConfirmAction.jsx";
export default function DefinitionsPage({ route, navigate }) {
  const definitions = useResource("/pipelines"),
    profiles = useResource("/pipeline-profiles");
  const [removing, setRemoving] = useState(null);
  const items = definitions.data?.pipelines || [],
    selected = items.find((p) => p.id === route.pipelineItem);
  if (route.pipelineItem === "new" || selected)
    return (
      <PipelineBuilder
        key={route.pipelineItem}
        pipeline={selected}
        profiles={profiles.data?.profiles || []}
        saved={() => {
          definitions.refresh();
          navigate({ pipelineItem: "" });
        }}
        cancel={() => navigate({ pipelineItem: "" })}
      />
    );
  return (
    <section>
      <div className="pipeline-toolbar">
        <h2>{copy.definitions}</h2>
        <button
          className="button primary"
          onClick={() => navigate({ pipelineItem: "new" })}
        >
          {copy.newPipeline}
        </button>
      </div>
      <ErrorMessage error={definitions.error || profiles.error} />
      {route.pipelineItem && !selected && !definitions.loading && (
        <ErrorMessage error={copy.definitionUnavailable} />
      )}
      {definitions.loading && <p role="status">{copy.loading}</p>}
      {!definitions.loading && !items.length && <p>{copy.noDefinitions}</p>}
      {items.map((item) => (
        <article className="pipeline-card" key={item.id}>
          <h3>{item.name}</h3>
          <p>{item.description}</p>
          <small>
            {copy.stages}: {item.graph.nodes.filter((n) => n.kind === "profile").length}
          </small>
          <div className="pipeline-actions">
            <button
              className="button secondary"
              aria-label={copy.edit(item.name)}
              onClick={() => navigate({ pipelineItem: item.id })}
            >
              {copy.editLabel}
            </button>
            <button
              className="button primary"
              onClick={() =>
                navigate({
                  pipelineTab: "runs",
                  pipelineItem: "new",
                  selectedPipeline: item.id,
                })
              }
            >
              {copy.newRun}
            </button>
            <button
              className="button secondary"
              aria-label={copy.remove(item.name)}
              onClick={() => setRemoving(item)}
            >
              {commonCopy.remove}
            </button>
          </div>
        </article>
      ))}
      {removing && (
        <ConfirmAction
          description={copy.deleteDefinition}
          label={commonCopy.remove}
          close={() => setRemoving(null)}
          action={async () => {
            await api(`/pipelines/${removing.id}`, "DELETE");
            setRemoving(null);
            definitions.refresh();
          }}
        />
      )}
    </section>
  );
}
