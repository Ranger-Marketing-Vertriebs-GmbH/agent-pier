import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";

const camel = (reason) =>
  String(reason || "").replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

/** Why a run cannot return, from the options' `reason` (server return-blocks.js). */
export const returnBlockText = (reason) =>
  copy.returnToStage.blocked[camel(reason)] || copy.returnToStage.blockedOther;

/**
 * The stage picker's options; a name two stages share carries the stage id.
 * @param {{ id: string, name: string }[]} stages
 */
export const stageOptions = (stages) =>
  stages.map((stage) => ({
    value: stage.id,
    label:
      stages.filter((other) => other.name === stage.name).length > 1
        ? `${stage.name} · ${stage.id}`
        : stage.name || stage.id,
  }));
