import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import Icon from "../../components/Icon.jsx";
import useMobileLayout from "../../lib/useMobileLayout.js";
import { startPageCopy as copy } from "../../lib/i18n/messages/dashboard.js";
import { useHintsOf, useMenuHintSources } from "../../app/useMenuHints.js";
import useAssistantFeature, {
  FEATURE_CHECK_FAILED,
} from "../assistants/useAssistantFeature.js";
import useAssistants, { idleAssistants } from "../assistants/useAssistants.js";
import useStartInbox from "./useStartInbox.js";
import useSystemStatus from "./useSystemStatus.js";
import { attentionItems, systemAttention } from "./attention.js";
import { recentFailures, startAgents, startRuns } from "./start-agents.js";
import { sessionFilters, sessionItems } from "./start-lists.js";
import { readStartLayout, rememberStartLayout } from "./start-layout.js";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import StartHeader from "./StartHeader.jsx";
import NeedsYou from "./NeedsYou.jsx";
import SessionsCard from "./SessionsCard.jsx";
import SystemStatusTile from "./SystemStatusTile.jsx";
import AgentsCard from "./AgentsCard.jsx";
import PipelinesCard from "./PipelinesCard.jsx";
import ToolRows from "./ToolRows.jsx";
import PushHealthNotice from "../notifications/PushHealthNotice.jsx";
import "./start-page.css";
import "./start-cards.css";

const SystemStatusDialog = lazy(() => import("./SystemStatusDialog.jsx"));

/**
 * The start page: what runs and what needs you. Header, Needs you, sessions beside
 * the system status, agents beside the pipelines, the tools and a footer. Every tile
 * is in place from the first paint: until its data arrives it shows skeletons in the
 * shape the page had last time (start-layout.js), so nothing moves when it loads.
 */
export default function DashboardPage({
  state,
  availableTools,
  installed,
  error,
  ready,
  launch,
  page,
  setModal,
  navigate,
  openNavigation,
}) {
  const phone = useMobileLayout();
  const [dialog, setDialog] = useState(null);
  const status = useSystemStatus("/system-status", !dialog);
  const sources = useMenuHintSources(true);
  const hints = useHintsOf(sources, state, ready);
  const inbox = useStartInbox();
  const feature = useAssistantFeature();
  const assistants = useAssistants();
  const agentsEnabled = feature.enabled;
  const agentsLoaded =
    agentsEnabled && assistants !== idleAssistants && assistants.loaded;
  const [layout] = useState(readStartLayout);
  // Until the switch is read, agents count as on when they were on last time. A card
  // already shown stays, and says so when agents turn out to be off.
  const featureKnown = !feature.loading && feature.error !== FEATURE_CHECK_FAILED;
  const agentsShown = useRef(false);
  if (agentsEnabled || (!featureKnown && layout.agents)) agentsShown.current = true;
  const agentsCard = agentsShown.current;
  const agentItems = agentsLoaded
    ? startAgents({ ...assistants, copy: assistantCopy })
    : null;
  const system = systemAttention({
    serviceError: Boolean(error),
    status: status.data,
    hints,
    tools: state.tools,
    utilities: state.utilities,
    ready,
    appVersion: sources?.summary?.operations?.updates?.available || null,
  });
  const attention = attentionItems({
    inbox,
    system,
  });
  const counts = {
    sessions: ready
      ? state.sessions.filter(
          (s) => s.status === "running" && s.activity?.state === "working",
        ).length
      : null,
    agents: agentItems
      ? agentItems.filter((agent) => agent.state === "working").length
      : null,
    attention: attention.total,
  };
  const sessionList = ready ? sessionItems(state.sessions) : null;
  const runs = startRuns(sources?.runs);
  const seen = {
    agents: featureKnown ? agentsEnabled : undefined,
    attention: Array.isArray(inbox) ? attention.items.length : undefined,
    sessions: sessionList && {
      items: sessionList.length,
      rows: sessionList.filter((item) => sessionFilters.running(item.state)).length,
    },
    agentList: agentItems && { items: agentItems.length, rows: agentItems.length },
    runs: runs ? runs.length : undefined,
    tools: ready ? availableTools.length : undefined,
  };
  const seenKey = JSON.stringify(seen);
  useEffect(() => {
    rememberStartLayout(JSON.parse(seenKey));
  }, [seenKey]);
  const openStatus = (tab) => setDialog(tab);
  // CLI profiles (accounts of the coding CLIs, not the shell), once the state is loaded.
  const profiles = ready
    ? (state.accounts || []).filter((account) => account.tool !== "shell").length
    : null;
  const systemTile = (
    <SystemStatusTile
      data={status.data}
      error={status.error}
      onOpen={() => openStatus("load")}
      phone={phone}
    />
  );
  return (
    <div className="page dashboard start-page">
      <StartHeader
        counts={counts}
        agentsEnabled={agentsCard && (agentsEnabled || !featureKnown)}
        installed={installed}
        launch={launch}
        navigate={navigate}
        phone={phone}
      />
      <PushHealthNotice
        health={state.pushHealth ?? null}
        openSettings={() =>
          navigate({ view: "settings", settingsSection: "notifications" })
        }
      />
      <NeedsYou
        items={attention.items}
        loading={!Array.isArray(inbox)}
        shape={layout.attention}
        phone={phone}
        navigate={navigate}
        setModal={setModal}
        openStorage={() => openStatus("storage")}
      />
      {/* Phones show the system status right after Needs you (handoff mockup). */}
      {phone && systemTile}
      <div className="start-row-grid start-row-sessions">
        <SessionsCard
          sessions={state.sessions}
          ready={ready}
          shape={layout.sessions}
          figures={status.data?.sessions}
          navigate={navigate}
          openNavigation={openNavigation}
          phone={phone}
        />
        {!phone && systemTile}
      </div>
      {(agentsCard || !phone) && (
        <div className={`start-row-grid start-row-agents ${agentsCard ? "" : "single"}`}>
          {agentsCard && (
            <AgentsCard
              navigate={navigate}
              phone={phone}
              shape={layout.agentList}
              off={featureKnown && !agentsEnabled}
            />
          )}
          {!phone && (
            <PipelinesCard
              runs={sources?.runs}
              shape={layout.runs}
              navigate={navigate}
              phone={false}
            />
          )}
        </div>
      )}
      {phone ? (
        <div className="start-tiles">
          <PipelinesCard
            counts={{
              running: sources?.running,
              decisions: sources?.decisions,
              // Like the card: only failures of the last 24 hours (first page).
              failed: sources?.runs?.failed
                ? recentFailures(sources.runs.failed).length
                : null,
            }}
            loading={!sources}
            navigate={navigate}
            phone
          />
          <ToolRows
            tools={availableTools}
            profiles={profiles}
            ready={ready}
            navigate={navigate}
            phone
          />
        </div>
      ) : (
        <ToolRows
          tools={availableTools}
          profiles={profiles}
          ready={ready}
          shape={layout.tools}
          navigate={navigate}
          launch={launch}
          page={page}
          setModal={setModal}
        />
      )}
      <footer className="start-footer">
        <span>{copy.keepsRunning}</span>
        <span>
          <Icon name="shield" size={13} />
          {copy.localOnly}
        </span>
      </footer>
      {dialog && (
        <Suspense fallback={null}>
          <SystemStatusDialog
            close={() => setDialog(null)}
            cleanup={dialog === "storage"}
            openSession={navigate}
          />
        </Suspense>
      )}
    </div>
  );
}
