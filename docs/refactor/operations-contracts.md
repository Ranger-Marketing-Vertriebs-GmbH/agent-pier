# Operations HTTP contract

All endpoints below have `/api/operations` prefix and use existing owner authorization. Errors use the existing `{error}` response. Job objects have `{id,kind,status,createdAt,finishedAt?,result?,error?}`; status is `running`, `succeeded`, `failed`, or `interrupted`. Job IDs persist across web restarts. GET `/jobs/:id` returns `{job}`. Unknown interrupted work is never claimed successful.

## Diagnostics

- GET `/doctor` → `{report:null|{version,generatedAt,checks}}`.
- POST `/doctor` with `{scope:'host'|'project',projectId?,deep?:boolean}` → `{report}`. Each check has `{id,status,summary,remedy?,details?}` and status `ok|warn|fail|skip`. Report text is English diagnostic evidence; UI translates stable check/status labels.

## Backups

- GET `/backups` → `{backups:[{id,createdAt,bytes,withCredentials,includeHistory}]}`.
- POST `/backups/plan` with `{includeHistory?:boolean,withCredentials?:boolean}` → `{plan:{components,omissions,consistency,requiresPassphrase}}`.
- POST `/backups` with those options and optional `passphrase` → 202 `{job}`. Successful result is `{backup:{id,createdAt,bytes,withCredentials,includeHistory},manifest}`.
- GET `/backups/:id/download` downloads the owned archive; DELETE `/backups/:id` → 204.
- POST `/restore/upload` with raw `application/octet-stream` archive bytes → 201 `{archiveId}`. No multipart wrapper.
- POST `/restore/inspect` with `{archiveId,passphrase?,projectMap?:{[oldProjectId]:absoluteTargetDirectory}}` → `{inspection:{manifest,projects:[{id,name,cwd,kind}],requiresPassphrase,credentialsIncluded,omissions}}`.
- POST `/restore` with `{archiveId,targetDataDir,projectMap?,passphrase?}` → 202 `{job}`. Target must be an absolute, absent directory, outside the running data directory. All mapped project directories must already exist. Successful result includes `{targetDataDir,credentialsRestored,credentialsNeedingLogin,projectMappings,importedSessions,importedRuns,omissions}`. Restore never switches the running application's data directory or starts native sessions. Inspect without a passphrase can review public manifest/projects; restore authenticates the encrypted capsule before creating the target.

## Releases

- GET `/releases` → `{current,installed,supported,reason?,releases:[{version,current,canRollback,reason?}],staged:[{id,version}],channel}`. Source checkouts return `installed:false` with setup explanation; packaging and staging remain real supported CLI paths.
- POST `/releases/check` → `{plan:{current,version,upToDate,platform,sha256,bytes?,schemaVersion}}`.
- POST `/releases/stage` with `{version}` → 202 `{job}`; result `{stagedId,version}`.
- POST `/releases/activate` with `{stagedId}` → 202 `{job}`.
- POST `/releases/rollback` with `{version}` → 202 `{job}`.
- Activation jobs survive web restart. Poll the same job after reconnect. Result `{from,to,activated,rolledBack}` describes health-confirmed outcome. A failure remains `failed` even when rollback restores availability. Show only server-listed rollback choices.

No request accepts arbitrary backup output paths or service commands. Passphrases never enter durable job input, audit, or URLs. Release channel/install root are server configuration, not browser-supplied URLs. Downloads contain private task history; encrypted credentials are explicit opt-in.

## Imported AgentBus history

- GET `/imported-history/agentbus` → `{projects:[{id,historyOnly:true}]}`.
- GET `/imported-history/agentbus/:id?page=1` → `{projectId,historyOnly:true,items,total,page,pageSize:20,truncated}`. Items contain `{id,text,createdAt,from:{name,tool},to:{name,tool},status,historyOnly:true}`. Status is `read` or `pending-at-backup`; neither is actionable and no message is re-delivered. This section belongs on Backups when imported projects exist.
