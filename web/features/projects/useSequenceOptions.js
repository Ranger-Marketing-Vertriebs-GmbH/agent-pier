import { useEffect, useState } from "react";
import useResource from "../../lib/useResource.js";
import { isCodingCli } from "../../../server/features/clis/catalog.js";
import { defaultLaunchMode, rememberedLaunchMode } from "../sessions/launch-modes.js";
import useLaunchAccess from "../sessions/useLaunchAccess.js";
import { launchStart } from "./sequence-options.js";

// What the owner can change in the repair fields; equal snapshots mean untouched.
const repairChoice = (access, mode) =>
  [access.tool, access.accessId, access.modelId, access.nativeModelId, mode].join("\n");

/**
 * The options every ticket of a sequence or a label rule runs with: kind, the session
 * or the pipeline with its repair session (prefilled from `defaults.repair`) and
 * "Allow merge", off by default. `initial` is a rule's saved `{ kind, options }`; it
 * prefills every field instead of the defaults. `options` is the request body part,
 * `fieldProps` goes to `<SequenceOptionsFields>`.
 */
export default function useSequenceOptions({ state, defaults, initial }) {
  // Sequences and rules run coding CLIs only.
  const codingState = {
    accounts: [],
    providerConnections: [],
    ...state,
    tools: (state?.tools || []).filter((item) => isCodingCli(item.id)),
  };
  const saved = initial?.options || {};
  const [sessionStart] = useState(() =>
    initial?.kind === "session" ? launchStart(codingState, saved.session) : null,
  );
  // A rule's saved repair session, or the repo's last-used coding session.
  const repairSaved = initial
    ? initial.kind === "pipeline"
      ? saved.repair
      : null
    : defaults?.repair;
  const [repairDefaults, setRepairDefaults] = useState(() =>
    launchStart(codingState, repairSaved),
  );
  const session = useLaunchAccess(
    codingState,
    sessionStart ? saved.session.tool : undefined,
    sessionStart,
  );
  const repair = useLaunchAccess(
    codingState,
    repairDefaults ? repairSaved.tool : undefined,
    repairDefaults,
  );
  const [kind, setKind] = useState(initial?.kind || "session");
  const [sessionMode, setSessionMode] = useState(() =>
    sessionStart && saved.session.launchMode
      ? saved.session.launchMode
      : rememberedLaunchMode(session.tool) || defaultLaunchMode(session.tool),
  );
  const [repairMode, setRepairMode] = useState(() =>
    repairDefaults && repairSaved.launchMode
      ? repairSaved.launchMode
      : defaultLaunchMode(repair.tool),
  );
  // A saved sandbox profile comes back with the saved session.
  useEffect(() => {
    if (sessionStart && saved.session.nonoProfile)
      session.setNonoProfile(saved.session.nonoProfile);
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Defaults that arrive after the dialog opened (the queue view loads on its own)
  // still fill the repair fields, unless the owner already changed them.
  const [untouched] = useState(() => repairChoice(repair, repairMode));
  const lateDefaults =
    initial || repairDefaults ? null : launchStart(codingState, defaults?.repair);
  useEffect(() => {
    if (!lateDefaults || repairChoice(repair, repairMode) !== untouched) return;
    const { config } = lateDefaults;
    repair.chooseTool(defaults.repair.tool);
    repair.chooseAccess(
      config.providerConnectionId
        ? `provider:${config.providerConnectionId}`
        : config.accountId,
    );
    repair.setModel(config.models.default);
    repair.setNativeModel(config.models.default);
    setRepairMode(defaults.repair.launchMode || defaultLaunchMode(defaults.repair.tool));
    setRepairDefaults(lateDefaults);
    // Runs once the defaults turn usable; the snapshot check guards owner edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(lateDefaults)]);
  const [pipelineId, setPipelineId] = useState(saved.pipeline?.pipelineId || "");
  const [allowMerge, setAllowMerge] = useState(saved.allowMerge === true);
  const pipelines = useResource(kind === "pipeline" ? "/pipelines" : null);
  const ready = kind === "session" ? session.ready : Boolean(pipelineId);
  const options = {
    kind,
    allowMerge,
    ...(kind === "session"
      ? {
          session: {
            ...session.body,
            launchMode: sessionMode,
            agentbus: true,
            agentpierTools: true,
            sshAccessIds: [],
            ...(session.nonoProfile ? { nonoProfile: session.nonoProfile } : {}),
          },
        }
      : {
          pipeline: { pipelineId },
          ...(repair.ready ? { repair: { ...repair.body, launchMode: repairMode } } : {}),
        }),
  };
  return {
    kind,
    ready,
    options,
    fieldProps: {
      kind,
      setKind,
      session,
      sessionMode,
      setSessionMode,
      pipelineId,
      setPipelineId,
      pipelines,
      repair,
      repairMode,
      setRepairMode,
      // The note "prefilled from the latest coding session" fits the defaults only.
      repairPrefilled: Boolean(repairDefaults) && !initial,
      allowMerge,
      setAllowMerge,
    },
  };
}
