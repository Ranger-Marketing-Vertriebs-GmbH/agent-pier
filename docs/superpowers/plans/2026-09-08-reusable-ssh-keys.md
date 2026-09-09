# Reusable SSH keys

User-approved scope: named keys are managed independently, then selected for one or many hosts. Ship alongside pasted OpenSSH newline normalization in v1.8.0. Existing host/session access remains usable and private material never appears in HTTP responses or logs.

## Backend

- [x] Introduce SSH key catalog: list/get/create/rename/delete, private immutable material, public `{id,name,publicKey,fingerprint,createdAt,hosts:[{id,name}]}`. Delete referenced key returns409. Generated/imported keys use prepareIdentity normalization. No encrypted-key support change.
- [x] Existing host-owned keys appear in catalog through idempotent local migration; never destroy original key files. Interrupted migration must be retryable without losing keys or hosts. Keep key loading paths relative to connection.cwd to avoid OpenSSH expansion.
- [x] Host create/update supports `keyId`; disallow mixed `keyId` and privateKey. Preserve legacy create payload for API compatibility by generating/importing a named key. Public host includes keyId/keyName and existing public fields. Host removal never deletes a reusable key; key rename affects all host projections. Guard deletion races with async host create/update; recheck key existence at final commit.
- [x] Authenticated `/ssh-keys`: GET `{keys}`, POST `{name,privateKey?}` returnskey; PATCH `/:id` `{name}`; DELETE `/:id`204 or409. Extend existing SSH routes with catalog; keep session APIs unchanged.
- [x] Tests: two hosts same fingerprint/identity, rename propagation, in-use deletion, host deletion/reuse, replacement selection, malformed keyId, mixedinputs, concurrent key deletion/host save, restart and repeat migration; no remote systems.

## UI

- [x] Settings Server accesses: separate named keys section and hosts section, bilingual mobile-friendly dialogs. Key form name plus generate/import; public key/fingerprint and referencing hosts visible. Delete disabled when in use and server409 handled. Host form selects saved key; saving requires selection and confirmed host fingerprint. Changing onlykey does not reset hostfingerprint. Existing session assignment UI unchanged.
- [x] Initial loads gate Add buttons/selection; mutations preserve drafts on failure, no stale list overwrites. Existing host UI fixtures updated to reflect catalog API; preserve original coverage.
- [x] Browser tests: independent key creation/import (missingLF), two hosts reuse one key, key rename and deletion protection, failed mutations, existing migrated host editing, mobile DE/EN, no automatic agent input.

## Delivery

- [x] Document migration/storage/reuse and existing limitations (no OS isolation, SSH excluded backups, no encrypted-key support). Independent review found no actionable issues; full npm check passed (875 tests), focused SSH browser tests passed in Chromium and WebKit (9 each).
- [ ] Complete full browser checks, PR and required CI, release 1.8.0 and installed updater validation. No direct main pushes.
