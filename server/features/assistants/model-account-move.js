import path from "node:path";
import { assistantProblem } from "./assistant-validation.js";
import { scrubBackupProfile } from "./runtime-update-scrub.js";
import { tokenIdentity } from "../model-logins/chatgpt-auth.js";

/**
 * The owner's explicit "Move this ChatGPT login to AgentPier" for account `id`, a
 * login OpenClaw holds (model-accounts.js holder "openclaw"). Never automatic.
 *
 * 1. Refused while an agent run uses the account (409): the account must be idle.
 * 2. Every update snapshot taken before is rewritten without the profile's refresh
 *    token (runtime-update-scrub.js), so a rollback stays possible and never brings
 *    back a second refresher; a part it cannot rewrite restores without credentials.
 *    Before every Gateway start AgentPier writes its access-only profile again
 *    (model-accounts.js syncAll), also over whatever a restore brought back.
 * 3. In one transaction on OpenClaw's own store, the refresh token is read once and
 *    the profile left access-only (models sub-port takeStored); OpenClaw's refresh
 *    claim re-reads the store under its lock, so it never redeems the old token
 *    afterwards. A profile in the middle of an OpenClaw refresh is refused.
 * 4. The tokens go into AgentPier's vault under the same profile id, so agents'
 *    `openai/<model>@<profileId>` selections stay as they are, and OpenClaw keeps
 *    every ChatGPT feature on the access-only profile AgentPier renews from now on.
 */
export async function moveAccount(accounts, id) {
  if (!accounts.vault) throw assistantProblem("unavailable", 503);
  if (accounts.leases.has(id)) throw assistantProblem("active", 409);
  const record = accounts.record(id);
  if (accounts.holderOf(id) !== "openclaw") throw assistantProblem("invalid", 400);
  await scrubBackupProfile(path.dirname(accounts.file), record.profileId);
  let taken;
  try {
    taken = await accounts.port().takeStored({ profileId: record.profileId });
  } catch (error) {
    accounts.warn(
      `The ChatGPT login could not be moved to AgentPier (${
        /^[A-Z_]{1,40}$/.test(error?.code || "") ? error.code : "unexpected error"
      }).`,
    );
    throw assistantProblem(
      error?.code === "REFRESH_IN_PROGRESS" ? "active" : "unavailable",
      error?.code === "REFRESH_IN_PROGRESS" ? 409 : 503,
    );
  }
  const credential = taken?.credential;
  if (!credential?.refresh || !credential.access) throw assistantProblem("provider");
  const identity = tokenIdentity(credential.access);
  accounts.vault.save(
    {
      access: credential.access,
      refresh: credential.refresh,
      expires: Number(credential.expires) || identity.expires,
      accountId: credential.accountId || identity.accountId,
      email: credential.email || identity.email,
      plan: credential.chatgptPlanType || identity.plan,
      residency: identity.residency,
    },
    { profileId: record.profileId, displayName: credential.displayName },
  );
  // Renewed now when due; OpenClaw's profile follows the vault (sync).
  await accounts.vault.credential(record.profileId).catch(() => {});
  await accounts.sync(record.profileId);
  return accounts.list();
}
