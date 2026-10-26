import React, { lazy, Suspense, useId } from "react";
import GroupLabel from "../../components/GroupLabel.jsx";
import ListCard from "../../components/ListCard.jsx";
import ListRow from "../../components/ListRow.jsx";
import { routePath } from "../../app/routes.js";
import { connectionsAreaCopy as copy } from "../../lib/i18n/messages/connections-area.js";
import CategorySection from "./CategorySection.jsx";
import ConnectionUsedBy from "./ConnectionUsedBy.jsx";
import EmptyCategory from "./EmptyCategory.jsx";
import { auditRoute, connectionsRoute } from "./routes.js";

const SecretsSettings = lazy(() => import("../secrets/SecretsSettings.jsx"));
const GithubAccessPage = lazy(() => import("../settings/GithubAccessPage.jsx"));

const usageOf = (usage, group, id) =>
  usage ? (usage[group] ? (usage[group][id] ?? null) : null) : undefined;

/** "Verwalten" of a secret or token profile: its entries in the activity log. */
function ManageGroup({ id, navigate }) {
  const labelId = useId();
  const audit = auditRoute(id);
  return (
    <section className="connections-section" aria-labelledby={labelId}>
      <GroupLabel id={labelId}>{copy.manage.title}</GroupLabel>
      <ListCard labelledBy={labelId}>
        <ListRow
          label={copy.manage.activity}
          sub={copy.manage.activityHint}
          value={copy.manage.activityLink}
          href={routePath(audit)}
          onClick={() => navigate(audit)}
        />
      </ListCard>
    </section>
  );
}

/** Zugänge › Geheimnisse: the secrets list and form, with "Benutzt von" per secret. */
export function SecretsCategory({ shared, loading }) {
  const { connectionUsage, reloadAll, agentsEnabled, assistants, navigate } = shared;
  return (
    <CategorySection title={copy.sections.secrets}>
      <Suspense fallback={loading}>
        <SecretsSettings
          onChanged={reloadAll}
          emptyState={(openNew) => (
            <EmptyCategory
              icon="shield"
              title={copy.empty.secrets.title}
              body={copy.empty.secrets.body}
              actions={[{ label: copy.empty.secrets.primary, onClick: openNew }]}
            />
          )}
          usedBy={(secret) => (
            <div className="connections-detail-extra">
              <ConnectionUsedBy
                kind="secret"
                item={secret}
                usage={usageOf(connectionUsage, "secrets", secret.id)}
                agentsEnabled={agentsEnabled}
                assistants={assistants}
                navigate={navigate}
                onChanged={reloadAll}
              />
              <ManageGroup id={secret.id} navigate={navigate} />
            </div>
          )}
        />
      </Suspense>
    </CategorySection>
  );
}

/**
 * Zugänge › GitHub-Zugänge: the token profiles (check, edit, delete, add) with a
 * "Benutzt von" entry per profile; `item` opens one profile's full view.
 */
export function GithubCategory({ shared, item, loading }) {
  const { connectionUsage, reloadAll, agentsEnabled, assistants, navigate } = shared;
  const used = (credential) => {
    const entry = usageOf(connectionUsage, "github", credential.id);
    if (!entry) return null;
    return (
      (entry.agents?.length || 0) + (entry.projects?.length || 0) + (entry.sessions || 0)
    );
  };
  return (
    <CategorySection title={copy.sections.github}>
      <Suspense fallback={loading}>
        <GithubAccessPage
          only={item || undefined}
          onChanged={(_credential, deletedId) => {
            reloadAll();
            if (deletedId && deletedId === item)
              navigate(connectionsRoute("github"), true);
          }}
          emptyState={(openAdd) => (
            <EmptyCategory
              icon="link"
              title={copy.empty.github.title}
              body={copy.empty.github.body}
              actions={[{ label: copy.empty.github.primary, onClick: openAdd }]}
            />
          )}
          rowExtra={
            item
              ? undefined
              : (credential) => {
                  const route = connectionsRoute("github", credential.id);
                  const count = used(credential);
                  return (
                    <a
                      className="button secondary compact"
                      href={routePath(route)}
                      aria-label={copy.githubDetails(credential.name)}
                      onClick={(event) => {
                        event.preventDefault();
                        navigate(route);
                      }}
                    >
                      {count === null ? copy.details : copy.githubUsedBy(count)}
                    </a>
                  );
                }
          }
          after={(credential) => (
            <div className="connections-detail-extra">
              <ConnectionUsedBy
                kind="github"
                item={credential}
                usage={usageOf(connectionUsage, "github", credential.id)}
                agentsEnabled={agentsEnabled}
                assistants={assistants}
                navigate={navigate}
                onChanged={reloadAll}
              />
              <ManageGroup id={credential.id} navigate={navigate} />
            </div>
          )}
        />
      </Suspense>
    </CategorySection>
  );
}
