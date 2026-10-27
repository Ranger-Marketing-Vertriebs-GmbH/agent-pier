import React, { lazy, Suspense, useState } from "react";
import Icon from "../../components/Icon.jsx";
import useMobileLayout from "../../lib/useMobileLayout.js";
import { startPageCopy as copy } from "../../lib/i18n/messages/dashboard.js";
import { useHintsOf, useMenuHintSources } from "../../app/useMenuHints.js";
import useAssistantFeature from "../assistants/useAssistantFeature.js";
import useAssistants, { idleAssistants } from "../assistants/useAssistants.js";
import useStartInbox from "./useStartInbox.js";
import useSystemStatus from "./useSystemStatus.js";
import { attentionItems, systemAttention } from "./attention.js";
import { startAgents } from "./start-agents.js";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import StartHeader from "./StartHeader.jsx";
import NeedsYou from "./NeedsYou.jsx";
import SessionsCard from "./SessionsCard.jsx";
import SystemStatusTile from "./SystemStatusTile.jsx";
import AgentsCard from "./AgentsCard.jsx";
import PipelinesCard from "./PipelinesCard.jsx";
import ToolRows from "./ToolRows.jsx";
import "./start-page.css";

const SystemStatusDialog = lazy(() => import("./SystemStatusDialog.jsx"));
// The menu hint sources change slowly; the start page reads them twice a minute.
const HINT_POLL_MS = 30_000;

/**
 * The start page: what runs and what needs you. Header, Needs you, sessions beside
 * the system status, agents beside the pipelines, the tools and a footer.
 */
export default function DashboardPage({
  state,
  availableTools,
  installed,
  error,
  loading,
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
  const sources = useMenuHintSources(true, { poll: HINT_POLL_MS });
  const hints = useHintsOf(sources, state, ready);
  const inbox = useStartInbox();
  const feature = useAssistantFeature();
  const assistants = useAssistants();
  const agentsEnabled = feature.enabled;
  const agentsLoaded =
    agentsEnabled && assistants !== idleAssistants && assistants.loaded;
  const system = systemAttention({
    serviceError: Boolean(error),
    status: status.data,
    hints,
    tools: state.tools,
    utilities: state.utilities,
    ready,
    appVersion: sources?.summary?.operations?.updates?.available || null,
    legacyTmux: state.legacyTmux?.sessions,
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
    agents: agentsLoaded
      ? startAgents({ ...assistants, copy: assistantCopy }).filter(
          (agent) => agent.state === "working",
        ).length
      : null,
    attention: attention.total,
  };
  const openStatus = (tab) => setDialog(tab);
  // CLI profiles (accounts of the coding CLIs, not the shell), once the state is loaded.
  const profiles = ready
    ? (state.accounts || []).filter((account) => account.tool !== "shell").length
    : null;
  return (
    <div className="page dashboard start-page">
      <StartHeader
        counts={counts}
        agentsEnabled={agentsEnabled}
        installed={installed}
        launch={launch}
        navigate={navigate}
        phone={phone}
      />
      <NeedsYou
        items={attention.items}
        phone={phone}
        navigate={navigate}
        setModal={setModal}
        openStorage={() => openStatus("storage")}
      />
      <div className="start-row-grid start-row-sessions">
        <SessionsCard
          sessions={state.sessions}
          figures={status.data?.sessions}
          navigate={navigate}
          openNavigation={openNavigation}
          phone={phone}
        />
        <SystemStatusTile
          data={status.data}
          error={status.error}
          onOpen={() => openStatus("load")}
          phone={phone}
        />
      </div>
      {(agentsEnabled || !phone) && (
        <div
          className={`start-row-grid start-row-agents ${agentsEnabled ? "" : "single"}`}
        >
          {agentsEnabled && <AgentsCard navigate={navigate} phone={phone} />}
          {!phone && (
            <PipelinesCard runs={sources?.runs} navigate={navigate} phone={false} />
          )}
        </div>
      )}
      {phone ? (
        <div className="start-tiles">
          <PipelinesCard
            counts={{
              running: sources?.running,
              decisions: sources?.decisions,
              failed: sources?.failed,
            }}
            navigate={navigate}
            phone
          />
          <ToolRows
            tools={availableTools}
            profiles={profiles}
            navigate={navigate}
            phone
          />
        </div>
      ) : (
        <ToolRows
          tools={availableTools}
          profiles={profiles}
          loading={loading}
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
