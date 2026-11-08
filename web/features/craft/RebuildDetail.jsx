import React, { useId, useState } from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import SettingsShell from "../../components/SettingsShell.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import Switch from "../../components/Switch.jsx";
import useAsyncAction from "../../lib/useAsyncAction.js";
import { locale } from "../../lib/i18n/index.js";
import { craftCopy as copy } from "../../lib/i18n/messages/craft.js";
import { isPlainClick } from "../../components/link-click.js";
import { routePath } from "../../app/routes.js";
import { projectsRoute } from "../projects/routes.js";
import CraftQuestion from "./CraftQuestion.jsx";
import {
  latestCheck,
  similarityPercent,
  stepStates,
  usd,
} from "./rebuild-presentation.js";
import { craftRoute } from "./routes.js";
import { runningStatuses, useRebuild } from "./useRebuilds.js";

const chipTones = {
  starting: "running",
  building: "running",
  checking: "running",
  needs_you: "waiting",
  ready: "ok",
  paused: "neutral",
  failed: "error",
};

// A link that opens an app route in place (and in a new tab on a modified click).
function RouteLink({ route, onNavigate, children }) {
  return (
    <a
      className="button secondary"
      href={routePath(route)}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onNavigate(route);
      }}
    >
      {children}
    </a>
  );
}

/**
 * One rebuild (`craft.rebuild:<id>`): its status and steps, Pause or Continue, the
 * open questions and approvals, a follow-up, auto mode, the latest check, usage, the
 * last reply and the activity, with links to its project, its folder and a session.
 */
export default function RebuildDetail({ id, onNavigate, onLaunch }) {
  const { rebuild, error, activity, written, ...actions } = useRebuild(id);
  const back = () => onNavigate(craftRoute());
  return (
    <SettingsShell
      className="craft-page"
      title={rebuild?.name || copy.title}
      subtitle={rebuild ? copy.title : undefined}
      leading="back"
      onLeading={back}
    >
      {rebuild === null ? (
        <p className="craft-note">{copy.detail.gone}</p>
      ) : !rebuild ? (
        error ? (
          <ErrorMessage error={error} />
        ) : (
          <p className="loading" role="status">
            {copy.loading}
          </p>
        )
      ) : (
        <RebuildBody
          rebuild={rebuild}
          activity={activity}
          written={written}
          actions={actions}
          onNavigate={onNavigate}
          onLaunch={onLaunch}
        />
      )}
    </SettingsShell>
  );
}

function RebuildBody({ rebuild, activity, written, actions, onNavigate, onLaunch }) {
  const running = runningStatuses.has(rebuild.status);
  const questionsId = useId();
  const action = useAsyncAction();
  const questions = rebuild.questions || [];
  return (
    <>
      <section className="craft-summary">
        <div className="craft-summary-head">
          <StatusChip tone={chipTones[rebuild.status] ?? "neutral"} pill>
            {copy.status[rebuild.status] ?? rebuild.statusLabel ?? rebuild.status}
          </StatusChip>
          {copy.source[rebuild.source] && (
            <small className="craft-meta">{copy.source[rebuild.source]}</small>
          )}
        </div>
        <ol className="craft-steps" aria-label={copy.steps.label}>
          {stepStates(rebuild.step, rebuild.status).map((step) => (
            <li
              key={step.id}
              className={`craft-step ${step.state}`}
              aria-current={step.state === "current" ? "step" : undefined}
            >
              {copy.steps[step.id]}
            </li>
          ))}
        </ol>
        {rebuild.note && (
          <p className="craft-text" dir="auto">
            {rebuild.note}
          </p>
        )}
        <div className="craft-actions">
          {running ? (
            <button
              type="button"
              className="button secondary"
              disabled={action.busy}
              onClick={() => action.run(actions.pause)}
            >
              {action.busy ? copy.detail.pausing : copy.detail.pause}
            </button>
          ) : ["paused", "failed"].includes(rebuild.status) ? (
            <button
              type="button"
              className="button primary"
              disabled={action.busy}
              onClick={() => action.run(actions.resume)}
            >
              {action.busy ? copy.detail.continuing : copy.detail.continue}
            </button>
          ) : null}
          {rebuild.projectId && (
            <RouteLink
              route={projectsRoute({ projectId: rebuild.projectId })}
              onNavigate={onNavigate}
            >
              {copy.detail.openProject}
            </RouteLink>
          )}
          {rebuild.folder && (
            <>
              <RouteLink
                route={{ view: "files", filePath: `${rebuild.folder}/app` }}
                onNavigate={onNavigate}
              >
                {copy.detail.openFolder}
              </RouteLink>
              <button
                type="button"
                className="button secondary"
                onClick={() => onLaunch(rebuild.folder)}
              >
                {copy.detail.openSession}
              </button>
            </>
          )}
        </div>
        <ErrorMessage error={action.error} />
      </section>
      {questions.length > 0 && (
        <section className="craft-section" aria-labelledby={questionsId}>
          <GroupLabel id={questionsId}>{copy.detail.questions}</GroupLabel>
          <div className="craft-questions">
            {questions.map((question) => (
              <CraftQuestion
                key={question.id}
                rebuildId={rebuild.id}
                question={question}
                onAnswered={written}
                onGone={written}
              />
            ))}
          </div>
        </section>
      )}
      {!running && <FollowUp send={actions.followUp} />}
      <AutoMode rebuild={rebuild} set={actions.autoMode} />
      <Facts rebuild={rebuild} />
      <Activity activity={activity} />
    </>
  );
}

function FollowUp({ send }) {
  const id = useId();
  const action = useAsyncAction();
  const [text, setText] = useState("");
  const submit = (event) => {
    event.preventDefault();
    action.run(async () => {
      await send(text);
      setText("");
    });
  };
  return (
    <section className="craft-section" aria-labelledby={id}>
      <GroupLabel id={id}>{copy.detail.followUp}</GroupLabel>
      <form className="craft-follow-up" onSubmit={submit}>
        <label>
          {copy.detail.followUpHint}
          <textarea
            dir="auto"
            rows={3}
            required
            maxLength={8000}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <ErrorMessage error={action.error} />
        <div className="craft-actions">
          <button type="submit" className="button primary" disabled={action.busy}>
            {action.busy ? copy.detail.sending : copy.detail.followUpSend}
          </button>
        </div>
      </form>
    </section>
  );
}

function AutoMode({ rebuild, set }) {
  const action = useAsyncAction();
  // The switch shows the asked value until the rebuild's push confirms it.
  const [asked, setAsked] = useState(null);
  return (
    <section className="craft-section">
      <Switch
        label={copy.detail.autoMode}
        checked={action.busy && asked !== null ? asked : rebuild.autoMode === true}
        disabled={action.busy}
        onChange={(on) => {
          setAsked(on);
          action.run(() => set(on));
        }}
        aria-describedby={`craft-auto-${rebuild.id}`}
      />
      <p className="craft-row-note" id={`craft-auto-${rebuild.id}`}>
        {copy.start.autoModeHint}
      </p>
      <ErrorMessage error={action.error} />
    </section>
  );
}

// The latest check with its similarity, the usage, the request and the last reply.
function Facts({ rebuild }) {
  const check = latestCheck(rebuild.checks);
  const similarity = similarityPercent(rebuild.similarity);
  const usage = rebuild.usage || {};
  const number = (value) => new Intl.NumberFormat(locale).format(value || 0);
  const checkName = check?.name || copy.detail.checkName;
  const checkText = !check
    ? copy.detail.noCheck
    : check.passed === false
      ? copy.detail.checkFailed(checkName)
      : check.passed === true
        ? copy.detail.checkPassed(checkName)
        : checkName;
  return (
    <section className="craft-section">
      <ListCard>
        <ListRow
          label={copy.detail.checkTitle}
          sub={
            similarity === null
              ? checkText
              : `${checkText} · ${copy.detail.similarity(similarity)}`
          }
        />
        <ListRow
          label={copy.detail.usage}
          sub={copy.detail.tokens(number(usage.inputTokens), number(usage.outputTokens))}
          value={copy.detail.cost(usd(usage.costUsd || 0, locale))}
        />
        <TextRow label={copy.detail.request} text={rebuild.request} />
        {rebuild.lastReply && (
          <TextRow label={copy.detail.lastReply} text={rebuild.lastReply} />
        )}
      </ListCard>
    </section>
  );
}

// A row with a label above a longer text that keeps its line breaks.
function TextRow({ label, text }) {
  return (
    <div className="list-row two-line craft-text-row">
      <div className="list-row-main">
        <span className="list-row-text">
          <span className="list-row-label">{label}</span>
          <span className="list-row-sub craft-text" dir="auto">
            {text}
          </span>
        </span>
      </div>
    </div>
  );
}

function Activity({ activity }) {
  const id = useId();
  return (
    <section className="craft-section" aria-labelledby={id}>
      <GroupLabel id={id}>{copy.detail.activity}</GroupLabel>
      {activity.error ? (
        <ErrorMessage error={activity.error} />
      ) : activity.lines === null ? (
        <p className="loading" role="status">
          {copy.detail.activityLoading}
        </p>
      ) : activity.lines.length === 0 ? (
        <p className="craft-note">{copy.detail.activityEmpty}</p>
      ) : (
        <pre className="craft-activity" tabIndex={0} aria-labelledby={id}>
          {activity.lines.join("\n")}
        </pre>
      )}
    </section>
  );
}
