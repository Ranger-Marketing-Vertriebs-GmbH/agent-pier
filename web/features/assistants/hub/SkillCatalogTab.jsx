import React, { useState } from "react";
import ConfirmDialog from "../../../components/ConfirmDialog.jsx";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import FilterChips from "../../../components/FilterChips.jsx";
import StatusChip from "../../../components/StatusChip.jsx";
import api from "../../../lib/api.js";
import { agentSkillCatalogCopy as copy } from "../../../lib/i18n/messages/agent-skill-catalog.js";
import { commonCopy } from "../../../lib/i18n/messages/common.js";
import {
  skillListCopy as listCopy,
  skillScanCopy as scanCopy,
} from "../../../lib/i18n/messages/skill-scan.js";
import SkillGroups, { SkillRow } from "../../extensions/SkillGroups.jsx";
import SkillInstallForm from "../../extensions/SkillInstallForm.jsx";
import { groupSkills, searchSkills } from "../../extensions/skill-groups.js";
import CatalogSkillDetail from "./CatalogSkillDetail.jsx";
import {
  catalogFilters,
  catalogGroupMeta,
  catalogSkillLimit,
  catalogSkillUsage,
  catalogSource,
  catalogSourceCheck,
  matchesFilter,
} from "./catalog-skill-view.js";
import useSkillCatalog from "./useSkillCatalog.js";
import "../../extensions/extensions.css";
import "../../extensions/extensions-hub.css";

const paths = {
  preview: "/agent-skill-catalog/skills/preview",
  install: "/agent-skill-catalog/skills",
  // A checked source with several skills: its per-skill preview and its install.
  collection: (id) => `/agent-skill-catalog/collections/${encodeURIComponent(id)}`,
};
const filterLabels = () => ({
  all: listCopy.filterAll,
  used: copy.filterUsed,
  unused: copy.filterUnused,
  findings: copy.filterFindings,
});

/** What a row says below the description: a scan with findings, or a limit. */
function rowNote(skill) {
  const verdict = skill.scan?.verdict;
  const limit = catalogSkillLimit(skill);
  if (!limit && (!verdict || verdict === "ok")) return null;
  return (
    <>
      {verdict && verdict !== "ok" && (
        <StatusChip tone={verdict === "block" ? "error" : "waiting"}>
          {skill.scan.overridden ? copy.overridden : scanCopy.verdicts[verdict]}
        </StatusChip>
      )}
      {limit && <span className="skill-row-limit">{limit}</span>}
    </>
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
 * skills) are grouped by their source; a row says how many agents use the skill and
 * opens its detail view, where it is switched on per agent, updated and removed.
 */
export default function SkillCatalogTab() {
  const catalog = useSkillCatalog();
  const { skills, panel } = catalog;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [openId, setOpenId] = useState(null);
  const updating = Boolean(panel?.skill);
  // Check for update opens with the found version; Upload new version starts empty.
  const updateTitle = panel?.preview ? copy.checkedUpdateTitle : copy.updateTitle;
  const found = skills ? searchSkills(skills, query) : [];
  const shown = found.filter((skill) => matchesFilter(skill, filter));
  const groups = groupSkills(shown, catalogSource).map((group) => {
    const source = catalogSourceCheck(group);
    return {
      ...group,
      meta: catalogGroupMeta(group),
      action: source && (
        <button
          type="button"
          className="button secondary compact"
          aria-label={copy.checkUpdatesLabel(source.repository)}
          disabled={Boolean(catalog.busy)}
          onClick={() => catalog.checkSource(source)}
        >
          {copy.checkUpdates}
        </button>
      ),
    };
  });
  // An update check of a repository opens with its skills and the updates picked.
  const sourceUpdate = panel?.collection
    ? {
        initialCollection: panel.collection,
        initialPicked: panel.collection.skills
          .filter(
            (skill) =>
              skill.state === "update" &&
              !skill.review &&
              panel.updates.includes(skill.replaces?.id),
          )
          .map((skill) => skill.folder),
        collectionLabels: {
          installAction: copy.sourceInstallAction,
          installedNotice: copy.sourceInstalledNotice,
        },
      }
    : null;
  const open = skills?.find((skill) => skill.id === openId) || null;
  // The install panel and the remove dialog show their own messages.
  const detail = open && !panel ? open : null;
  return (
    <div className="agents-hub-skills">
      <p className="field-description">{copy.lead}</p>
      <div className="skill-list-toolbar">
        <input
          type="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-label={commonCopy.searchSkills}
          placeholder={copy.searchPlaceholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="button secondary"
          disabled={Boolean(catalog.busy)}
          onClick={() => catalog.openPanel()}
        >
          {copy.install}
        </button>
      </div>
      {skills?.length > 0 && (
        <FilterChips
          label={listCopy.filterLabel}
          value={filter}
          onChange={setFilter}
          options={catalogFilters.map((value) => ({
            value,
            label: filterLabels()[value],
            count: found.filter((skill) => matchesFilter(skill, value)).length,
          }))}
        />
      )}
      {!detail && catalog.notice && (
        <p role="status" className="skill-list-notice">
          {catalog.notice}
        </p>
      )}
      {!panel && !detail && (
        <ErrorMessage error={catalog.error} as="p" className="error" />
      )}
      <ErrorMessage error={catalog.loadError} as="p" className="error" />
      {skills === null ? (
        !catalog.loadError && <p role="status">{copy.loading}</p>
      ) : !skills.length ? (
        <p className="extension-empty">{copy.empty}</p>
      ) : groups.length ? (
        <SkillGroups
          label={copy.listLabel}
          groups={groups}
          row={(skill) => (
            <SkillRow
              key={skill.id}
              name={skill.name}
              description={skill.description}
              note={rowNote(skill)}
              value={catalogSkillUsage(skill)}
              onClick={() => setOpenId(skill.id)}
            />
          )}
        />
      ) : (
        <p className="extension-empty">{listCopy.noMatches}</p>
      )}
      {detail && (
        <CatalogSkillDetail
          skill={detail}
          catalog={catalog}
          close={() => {
            catalog.clearMessages();
            setOpenId(null);
          }}
        />
      )}
      {panel && (
        <SkillInstallForm
          key={`${panel.skill?.id || "new"}-${panel.preview?.previewId || panel.collection?.collectionId || ""}`}
          {...sourceUpdate}
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
          title={
            updating
              ? updateTitle
              : sourceUpdate
                ? copy.sourceUpdateTitle
                : copy.installTitle
          }
          subtitle={panel.skill?.name || panel.source}
          installLabel={updating ? copy.updateAction : copy.installAction}
          successNotice={updating ? copy.updatedNotice : copy.installedNotice}
          initialPreview={panel.preview || null}
          previewFields={updating ? { skillId: panel.skill.id } : null}
          limitsDescription={updating ? undefined : copy.sourceLimits}
        />
      )}
      {catalog.removing && <RemoveDialog catalog={catalog} />}
    </div>
  );
}
