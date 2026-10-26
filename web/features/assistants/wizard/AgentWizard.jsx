import React, { useEffect, useMemo, useRef, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import Icon from "../../../components/Icon.jsx";
import StatusDot from "../../../components/StatusDot.jsx";
import UnsavedChangesSheet from "../../../components/UnsavedChangesSheet.jsx";
import api from "../../../lib/api.js";
import { sameValue } from "../../../lib/settings/draft-state.js";
import useUnsavedChangesGuard from "../../../lib/settings/useUnsavedChangesGuard.js";
import { agentWizardCopy as copy } from "../../../lib/i18n/messages/agent-wizard.js";
import { agentTemplateCopy } from "../../../lib/i18n/messages/agent-templates.js";
import { agentsHubCopy } from "../../../lib/i18n/messages/agents-hub.js";
import { assistantCopy } from "../../../lib/i18n/messages/assistants.js";
import { assistantSettingsCopy } from "../../../lib/i18n/messages/assistant-settings.js";
import { commonCopy } from "../../../lib/i18n/messages/common.js";
import { usersCopy } from "../../../lib/i18n/messages/users.js";
import { ownerUsersApi } from "../../users/owner-users-api.js";
import { assistantApi } from "../assistant-api.js";
import { browserTimeZone } from "../heartbeat.js";
import { hubLists } from "../hub/agent-rows.js";
import ConfirmationSheet from "../settings/ConfirmationSheet.jsx";
import TemplatePicker from "../settings/TemplatePicker.jsx";
import useAssistants from "../useAssistants.js";
import CreationResult from "./CreationResult.jsx";
import StepAccess from "./StepAccess.jsx";
import StepCapabilities from "./StepCapabilities.jsx";
import StepChannels from "./StepChannels.jsx";
import StepIdentity from "./StepIdentity.jsx";
import StepReview from "./StepReview.jsx";
import StepStart from "./StepStart.jsx";
import WizardFrame from "./WizardFrame.jsx";
import useWizardCreation from "./useWizardCreation.js";
import {
  duplicateFields,
  emptyDraft,
  forUserAgent,
  optionalSteps,
  stepProblem,
  wizardSteps,
} from "./wizard-draft.js";

const hub = { view: "agents" };
// The draft stays on the wizard's own address; other navigations ask first.
const staysInWizard = (request) =>
  request?.next?.view === "agents" && Boolean(request.next.creating);

/** Template preview fields kept in the draft (TemplateNote needs them). */
const templateOf = (preview) => ({
  id: preview.id,
  revision: preview.revision,
  name: preview.name,
  source: preview.source,
  verdict: preview.verdict,
  findings: preview.findings || [],
  instructions: preview.instructions,
});

/**
 * Neuer Agent (handoff 5.3): six steps over one draft held here, never in storage, so
 * side sheets and step changes keep it; leaving asks while it holds changes. Creating
 * runs the plan of wizard-creation.js and shows each step's result; then the chat.
 */
export default function AgentWizard({ route, navigate }) {
  const { assistants, models = [], policies = {}, runtime } = useAssistants();
  const initial = useMemo(() => emptyDraft(browserTimeZone()), []);
  const [d, setDraft] = useState(() => ({
    ...initial,
    ...(route.forUser ? { owner: route.forUser } : {}),
  }));
  const set = (patch) => setDraft((old) => ({ ...old, ...patch }));
  const [step, setStep] = useState("start");
  const [reached, setReached] = useState(0);
  const [problem, setProblem] = useState("");
  const [startError, setStartError] = useState("");
  const [picking, setPicking] = useState(false);
  const [users, setUsers] = useState([]);
  const [usersError, setUsersError] = useState("");
  const [webSearchReady, setWebSearchReady] = useState(null);
  const [createError, setCreateError] = useState("");
  const creation = useWizardCreation();
  const finished = useRef(false);
  const sources = hubLists(assistants);
  const duplicable = [...sources.own, ...sources.ofUsers];
  useEffect(() => {
    ownerUsersApi
      .list()
      .then((list) => setUsers(list.filter((u) => !u.disabled || u.id === route.forUser)))
      .catch((e) => setUsersError(e.message));
    assistantApi
      .webSearch()
      .then((search) => setWebSearchReady(search?.ready !== false))
      .catch(() => {});
  }, [route.forUser]);
  // A template from the address (an Agency entry's "Persönlichen Agenten anlegen").
  const templateId = route.template?.id,
    templateRevision = route.template?.revision;
  useEffect(() => {
    if (!templateId) return undefined;
    let active = true;
    assistantApi
      .template(templateId, templateRevision)
      .then((preview) => {
        if (!active) return;
        if (preview.verdict === "block") setStartError(agentTemplateCopy.blocked);
        else applyTemplate(preview);
      })
      .catch((e) => active && setStartError(e.message));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, templateRevision]);
  const applyTemplate = (preview) => {
    setPicking(false);
    set({
      start: "template",
      template: templateOf(preview),
      name: Array.from(preview.name).slice(0, 100).join(""),
      instructions: preview.instructions,
    });
  };
  // Leaving a template takes its third-party name and instructions with it.
  const chooseStart = (start) =>
    set({
      start,
      ...(start !== "template" && d.template
        ? { template: null, name: "", instructions: "" }
        : {}),
      ...(start !== "duplicate" ? { duplicateOf: "" } : {}),
    });
  // Duplicate (5.3.1): the source's access record is read; the rest is listed.
  const duplicate = async (id) => {
    setStartError("");
    if (!id) return set({ duplicateOf: "" });
    const agent = assistants.find((a) => a.id === id);
    if (!agent) return;
    try {
      const policy = await api(`/assistants/${encodeURIComponent(id)}/access`);
      set({
        start: "duplicate",
        duplicateOf: id,
        ...duplicateFields(agent, policy, policies[id] ?? null, copy.start.copyName),
      });
    } catch (e) {
      setStartError(e.message);
    }
  };
  const duplicateId = route.duplicate;
  const known = assistants.some((a) => a.id === duplicateId);
  useEffect(() => {
    if (duplicateId && known) duplicate(duplicateId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duplicateId, known]);
  const dirty =
    !finished.current &&
    !creation.agent &&
    !sameValue(d, { ...initial, ...(route.forUser ? { owner: route.forUser } : {}) });
  const sheet = useUnsavedChangesGuard({
    draft: { dirty, reset: () => setDraft(initial) },
    tab: assistantCopy.create,
    save: async () => ({ status: "cancelled" }),
    stays: staysInWizard,
  });
  const index = wizardSteps.indexOf(step);
  const go = (next) => {
    setProblem("");
    setStep(next);
    setReached((n) => Math.max(n, wizardSteps.indexOf(next)));
    queueMicrotask(() => document.getElementById("agent-wizard-step-title")?.focus());
  };
  const next = () => {
    const found = stepProblem(step, d);
    if (found) return setProblem(copy.problems[found]);
    go(wizardSteps[index + 1]);
  };
  const openChat = async (agent) => {
    finished.current = true;
    try {
      const chat = await assistantApi.open(agent.id);
      navigate({ view: "agents", assistantId: agent.id, conversationId: chat.id });
    } catch {
      navigate({ view: "agents", assistantId: agent.id, agentSettings: true });
    }
  };
  const create = async () => {
    const found = wizardSteps.map((s) => stepProblem(s, d)).find(Boolean);
    if (found) return setProblem(copy.problems[found]);
    setCreateError("");
    const outcome = await creation.start(forUserAgent(d));
    if (outcome.results.create?.status !== "done") {
      setCreateError(outcome.results.create?.error || copy.result.failed);
      creation.reset();
      return;
    }
    const failed = Object.values(outcome.results).some((r) => r.status === "failed");
    if (!failed) openChat(outcome.agent);
  };
  const owner = users.find((u) => u.id === d.owner);
  const ownerChoices = [
    { value: "", label: usersCopy.forMe },
    ...users.map((u) => ({ value: u.id, label: u.displayName })),
    ...(d.owner && !owner ? [{ value: d.owner, label: usersCopy.unknownUser }] : []),
  ];
  const result = creation.plan.length > 0 && (creation.agent || creation.running);
  const content = result ? (
    <CreationResult
      plan={creation.plan}
      results={creation.results}
      d={d}
      busy={creation.running}
      onRetry={(failedStep) => creation.retry(forUserAgent(d), failedStep)}
      onOpenChat={() => openChat(creation.agent)}
      onSettings={() => {
        finished.current = true;
        navigate({ view: "agents", assistantId: creation.agent.id, agentSettings: true });
      }}
    />
  ) : step === "start" ? (
    <StepStart
      d={d}
      set={set}
      sources={duplicable}
      users={users}
      ownerChoices={ownerChoices}
      onPickTemplate={() => setPicking(true)}
      onDuplicate={duplicate}
      onStart={chooseStart}
      error={startError || usersError}
    />
  ) : step === "identity" ? (
    <StepIdentity d={d} set={set} models={models} />
  ) : step === "capabilities" ? (
    <StepCapabilities d={d} set={set} runtime={runtime} models={models} />
  ) : step === "access" ? (
    <StepAccess d={d} set={set} navigate={navigate} />
  ) : step === "channels" ? (
    <StepChannels d={d} set={set} />
  ) : (
    <StepReview
      d={d}
      models={models}
      ownerName={owner?.displayName || usersCopy.unknownUser}
      sourceName={assistants.find((a) => a.id === d.duplicateOf)?.name || ""}
      runtime={runtime}
      webSearchReady={webSearchReady}
    />
  );
  const last = step === "review";
  const bar = !result && (
    <div className="save-bar agent-wizard-bar" role="region" aria-label={copy.stepsLabel}>
      <div className="save-bar-inner">
        <button
          type="button"
          className="button secondary"
          disabled={index === 0}
          onClick={() => go(wizardSteps[index - 1])}
        >
          {commonCopy.back}
        </button>
        <div className="agent-wizard-bar-actions">
          {optionalSteps.has(step) && (
            <button
              type="button"
              className="button secondary"
              onClick={() => go(wizardSteps[index + 1])}
            >
              {copy.skip}
            </button>
          )}
          <button
            type="button"
            className="button primary"
            disabled={creation.running}
            onClick={last ? create : next}
          >
            {last ? assistantSettingsCopy.createAgent : commonCopy.next}
          </button>
        </div>
      </div>
    </div>
  );
  const hasModel = models.some((m) => m.available !== false);
  const checks = [
    [
      runtime?.availability === "ready",
      agentsHubCopy.first.service,
      agentsHubCopy.first.serviceDown,
    ],
    [hasModel, agentsHubCopy.first.model, agentsHubCopy.first.noModel],
    ...(webSearchReady === null
      ? []
      : [
          [
            webSearchReady,
            agentsHubCopy.first.webSearch,
            agentsHubCopy.first.noWebSearch,
          ],
        ]),
  ];
  const aside = (
    <>
      <p className="agent-wizard-aside-title">{copy.prerequisites}</p>
      <ul className="agent-wizard-checks">
        {checks.map(([ok, yes, no]) => (
          <li key={yes}>
            {ok ? <Icon name="check" size={13} /> : <StatusDot tone="warning" />}
            <span>{ok ? yes : no}</span>
          </li>
        ))}
      </ul>
    </>
  );
  return (
    <WizardFrame
      step={step}
      reached={reached}
      onStep={go}
      onBack={() => navigate(hub)}
      aside={aside}
      bar={bar}
    >
      {content}
      <ErrorMessage error={problem || createError} />
      {picking && (
        <TemplatePicker onUse={applyTemplate} onClose={() => setPicking(false)} />
      )}
      <ConfirmationSheet
        confirmation={creation.confirmation}
        onShellCancel={() => set({ shell: "off" })}
      />
      <UnsavedChangesSheet {...sheet} saveDisabled />
    </WizardFrame>
  );
}
