import React from "react";
import ConfirmDialog from "../../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import ListCard from "../../../components/ListCard.jsx";
import ListRow from "../../../components/ListRow.jsx";
import StatusChip from "../../../components/StatusChip.jsx";
import api from "../../../lib/api.js";
import { agentSkillCatalogCopy as copy } from "../../../lib/i18n/messages/agent-skill-catalog.js";
import { commonCopy } from "../../../lib/i18n/messages/common.js";
import { skillScanCopy as scanCopy } from "../../../lib/i18n/messages/skill-scan.js";
import RowLines from "../../extensions/RowLines.jsx";
import { RowMenu, useRowMenu } from "../../extensions/RowMenu.jsx";
import SkillInstallForm from "../../extensions/SkillInstallForm.jsx";
import useSkillCatalog from "./useSkillCatalog.js";
import "../../extensions/extensions.css";
import "../../extensions/extensions-hub.css";

const paths = {
  preview: "/agent-skill-catalog/skills/preview",
  install: "/agent-skill-catalog/skills",
};
const verdictTones = { ok: "ok", warn: "waiting", block: "error" };

/** "Version N · from upload" or "… from GitHub <repo> @ <ref> (<short commit>)". */
export function catalogSkillSource(skill) {
  const origin = skill.origin;
  if (skill.importKind !== "github") return copy.versionUpload(skill.version);
  return origin?.repository && origin?.commit
    ? copy.versionGithub(skill.version, origin.repository, origin.ref, origin.commit)
    : copy.versionGithubPlain(skill.version);
}

/** The programs the running Gateway reports, or that they are unknown yet. */
export function catalogSkillPrograms(skill) {
  const needs = skill.requirements;
  if (!needs) return copy.programsPending;
  const programs = [
    ...(needs.bins || []),
    ...(needs.anyBins?.length ? [copy.oneOf(needs.anyBins.join(", "))] : []),
  ];
  return programs.length ? copy.runsPrograms(programs.join(", ")) : null;
}

// The limits the agent's Skills page shows as well (catalogView on the server).
const stateLine = (skill) =>
  skill.state === "damaged"
    ? copy.damaged
    : skill.state === "shadowed"
      ? skill.shadowedBy === "source"
        ? copy.shadowedSource
        : copy.shadowed
      : skill.state === "needsSettings" || skill.needsSettings
        ? copy.needsSettings
        : skill.state === "unavailable"
          ? copy.unavailable
          : null;

function Verdict({ scan }) {
  if (!scan?.verdict) return null;
  return (
    <StatusChip tone={verdictTones[scan.verdict] || "neutral"}>
      {scan.overridden ? copy.overridden : scanCopy.verdicts[scan.verdict]}
    </StatusChip>
  );
}

function CatalogRow({ skill, catalog }) {
  const menu = useRowMenu();
  const label = copy.rowActions(skill.name);
  const disabled = Boolean(catalog.busy);
  const agents = skill.agents || [];
  const items = [
    ...(skill.repository
      ? [
          {
            id: "check",
            label: copy.checkUpdate,
            disabled,
            run: () => catalog.checkUpdate(skill),
          },
        ]
      : []),
    {
      id: "upload",
      label: copy.uploadVersion,
      disabled,
      restoreFocus: false,
      run: () => catalog.openPanel(skill),
    },
    {
      id: "remove",
      label: commonCopy.remove,
      ariaLabel: commonCopy.removeSkillLabel(skill.name),
      danger: true,
      disabled,
      restoreFocus: false,
      run: () => catalog.setRemoving(skill),
    },
  ];
  return (
    <div className="row-menu-anchor">
      <ListRow
        label={skill.name}
        sub={
          <RowLines
            lines={[
              skill.description,
              catalogSkillSource(skill),
              <Verdict key="verdict" scan={skill.scan} />,
              catalogSkillPrograms(skill),
              stateLine(skill),
              agents.length ? copy.agentsOn(agents.length) : copy.agentsNone,
            ]}
          />
        }
        menu={{ label, expanded: menu.open, onClick: menu.toggle }}
      />
      <RowMenu label={label} state={menu} items={items} />
    </div>
  );
}

function RemoveDialog({ catalog }) {
  const skill = catalog.removing;
  const names = (skill.agents || []).map((agent) => agent.name);
  return (
    <ConfirmDialog
      title={copy.removeTitle(skill.name)}
      body={copy.removeBody}
      confirmLabel={commonCopy.remove}
      destructive
      onConfirm={catalog.remove}
      onCancel={() => catalog.setRemoving(null)}
    >
      <p>{names.length ? copy.removeAgents(names.join(", ")) : copy.removeUnused}</p>
    </ConfirmDialog>
  );
}

/**
 * Agents › Skills: the owner's skill catalog. Skills installed here (scanned like CLI
 * skills) can be switched on per agent; each row says where it came from, what the
 * scan found, which programs it runs and how many agents use it.
 */
export default function SkillCatalogTab() {
  const catalog = useSkillCatalog();
  const { skills, panel } = catalog;
  const updating = Boolean(panel?.skill);
  // Check for update opens with the found version; Upload new version starts empty.
  const updateTitle = panel?.preview ? copy.checkedUpdateTitle : copy.updateTitle;
  return (
    <div className="agents-hub-skills">
      <p className="field-description">{copy.lead}</p>
      <div className="agents-hub-toolbar">
        <button
          type="button"
          className="button secondary"
          disabled={Boolean(catalog.busy)}
          onClick={() => catalog.openPanel()}
        >
          {copy.install}
        </button>
      </div>
      {catalog.notice && <p role="status">{catalog.notice}</p>}
      {!panel && <ErrorMessage error={catalog.error} as="p" className="error" />}
      <ErrorMessage error={catalog.loadError} as="p" className="error" />
      {skills === null ? (
        !catalog.loadError && <p role="status">{copy.loading}</p>
      ) : skills.length ? (
        <ListCard label={copy.listLabel} className="extension-list">
          {skills.map((skill) => (
            <CatalogRow key={skill.id} skill={skill} catalog={catalog} />
          ))}
        </ListCard>
      ) : (
        <p className="extension-empty">{copy.empty}</p>
      )}
      {panel && (
        <SkillInstallForm
          key={`${panel.skill?.id || "new"}-${panel.preview?.previewId || ""}`}
          mutate={catalog.mutate}
          request={api}
          alive={catalog.alive}
          busy={catalog.busy}
          error={catalog.error}
          setError={catalog.setError}
          close={catalog.closePanel}
          paths={paths}
          destination={copy.destination}
          destinationLabel={copy.destinationLabel}
          title={updating ? updateTitle : copy.installTitle}
          subtitle={panel.skill?.name}
          installLabel={updating ? copy.updateAction : copy.installAction}
          successNotice={updating ? copy.updatedNotice : copy.installedNotice}
          initialPreview={panel.preview || null}
          previewFields={updating ? { skillId: panel.skill.id } : null}
        />
      )}
      {catalog.removing && <RemoveDialog catalog={catalog} />}
    </div>
  );
}
