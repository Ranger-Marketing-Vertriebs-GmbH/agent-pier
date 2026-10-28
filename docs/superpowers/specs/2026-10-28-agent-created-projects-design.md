# Agents create their own projects — design

Ticket: AGENTPIER-273 (created with this design).

## Intent

The owner gives an agent an idea that the agent and its team should build. Today the owner first has to create a folder, register it as a project in AgentPier and grant the agent access before the agent can store anything. The owner wants the agent to do this itself:

- The agent creates the project.
- The agent then has full access to it.
- The agent can share it with its team the same way it already shares projects.

## Goals

- An eligible agent can create a new, empty project folder inside the owner's default project folder and register it as an AgentPier project.
- On creation the agent gets read and write access to the project folder, plus the project grant used for memory and coding.
- The agent may switch on coding sessions for a project it created itself.
- No approval is needed. The owner gets an info notice in the agent's web chat and, if paired, in Telegram, saying that a project was created, with its name and path.
- Sharing the project with team members works through the existing lead share (`agentpier_team_grant`, `grants.projects` / `coding`, standing shares for permanent members). Nothing new is needed there.

## Non-goals

- Agents creating folders anywhere other than the default project folder.
- Adopting an existing folder as a project.
- Cloning repositories.
- Agents deleting, renaming or unregistering projects. The owner does that in the UI as today.
- Agents switching on coding sessions, folder access or pipelines for projects they did not create.
- New sharing mechanics.

## Anti-goals

These would make the feature a failure even if it technically works:

- An agent overwriting or taking over an existing folder.
- An agent creating a project outside the default folder, for example through `..`, absolute names or links.
- The owner not noticing that projects appear.
- An agent of a family member (user agent) or an agent with its own Telegram bot for other people getting this power.

## Decided by the owner

- **No approval.** The agent creates the project directly, and the owner gets an info message.
- **Location.** The project lives in the default project folder.
- **Coding sessions.** The agent may switch them on for a project it created.
- **Sharing.** Sharing existing projects with team members already works and stays as it is.

## Constraints

- **Location.**
  - The parent folder is the owner's default folder: `preferences.defaultCwd`, or the home folder when it is unset (`server/features/settings/preferences.js:35`).
  - The agent supplies only a folder name. Validate it with the same rules as `createDirectory` in `server/lib/directories.js:50`: no `/` or `\`, no control characters, not `.`/`..`, at most 255 bytes. In addition, no leading dot (no hidden folders).
  - Create it with the existing helper. An existing folder of that name is refused with a clear error, and the agent picks another name.
- **Registration.**
  - Use `ProjectMemory.register(cwd)` (`server/features/memory/project-memory.js:115`), so the project appears in the owner's project list like any registered folder.
  - The registered project's `cwd` must equal the newly created folder. Otherwise the call fails and the empty folder is removed again. Mismatches include `register` returning null (home or collection folder) and the folder resolving to an enclosing Git repository, for example when the default folder is inside a repository or the home folder is a dotfiles repository. An agent never gets access to an existing project this way.
- **Grants.**
  - Write only the fields this feature touches, with a narrow method modelled on `grantSsh` (`assistant-access.js:368-389`), in its own module because `assistant-access.js` is at its line limit:
    - `projectIds` += id;
    - `projectFiles[id] = "write"`;
    - with coding enabled, `sessionProjectIds` += id.
  - It bumps `revision` but keeps `approvalRevision`, so the agent's pending approvals stay valid and no pipeline hash is re-approved.
  - Do NOT go through `saveWork`/`prepare`. That path would cancel pending approvals, re-approve changed pipelines and fail on unrelated grants.
- **Who.**
  - The owner's own agents: not archived, not a user agent (`isUserAgent`), not a team member of any kind (`teamMemberId`), and not sender-facing (no own Telegram bot for other people, `assistantTelegramSenders.connected`).
  - Leads qualify; they are the main use.
  - Members never create projects; a lead creates and shares instead.
- **When.**
  - Only in a direct owner turn (`directOwnerTurn(origin)`), from web chat or the owner's paired Telegram chat.
  - Not in routines, hooks, team requests or forwarded content. Refuse those with a clear code, like `HOOK_OWNER_ONLY` and the SSH proposals do (`agent-ssh-proposals.js:96-108`).
- **Limits.** At most 10 projects per agent per rolling 24 hours (`PROJECT_CREATE_LIMIT`). This is a guard against loops, not a quota.
- **Remembering creation.** AgentPier remembers which agent created which project, in a new small table `agent_created_projects(project_id, assistant_id, created_at)`. Its rows go with agent deletion (add it to `agentTables` in `agent-deletion.js`).
  - The agent may later switch coding sessions on or off only for projects listed there for it. The owner can still change everything in the UI.
  - If the owner removes the agent's grant for that project, the agent cannot re-grant itself. Coding-on needs the project grant to still exist.
- **Notice.**
  - A settled action row in both chats, rendered like member-grant notes (`member-promotion.js:115-161`, `member-grant-notes.js`).
  - A Telegram message through `channels.outbox` when paired.
  - The text names the project, its folder path and whether coding sessions were switched on.
  - Switching coding on later also sends a notice.
  - Copy in German and English, following the i18n rules. German never says "Konto" or "Sitzung".
- **Audit.** Record project creation and the coding switch in the audit log with the agent as the actor: a new source or kind in `assistant-access-audit.js`, like the SSH proposals' `"proposal"` source. Do not record them as owner saves. If the audit UI labels sources, add de and en labels.
- **Git.**
  - The folder is initialised as a Git repository (`git init`) by default, so coding sessions can use worktrees. The agent can pass `git: false`.
  - `ProjectMemory` follows a `git init` (`followGitInit`), so register after initialising.
  - A failed `git init` fails the whole call and removes the folder.
- **Tool.**
  - A new own tool, `agentpier_project`, with these actions:
    - `create` (`name`, `git?`, `coding?`) returns `{projectId, name, path, coding}`;
    - `coding` (`projectId`, `enabled`) works only for projects this agent created;
    - `list` returns the projects this agent created and their state.
  - Error codes:
    - `PROJECT_NAME_INVALID`
    - `PROJECT_EXISTS`
    - `PROJECT_CREATE_LIMIT`
    - `PROJECT_OWNER_ONLY` (wrong turn origin)
    - `PROJECT_NOT_CREATED_BY_YOU`
    - `PROJECT_NOT_ELIGIBLE`
    - `PROJECT_FOLDER_UNAVAILABLE` (default folder missing or not writable)
  - The tool is in `senderLockedTools`, so it disappears for sender-facing agents.
  - Bootstrap guidance tells eligible agents that they can create a project for new work, then share it with their team via `agentpier_team_grant`.
- **Docs.** Update the docs for agents and projects, the gateway tool list and README feature lists where relevant.
- **Project rules.** Files at most 600 lines. `assistant-access.js` (597) and `team-bridge.js` (592) must not grow, so new logic goes into new modules.

## Left to the builder

- The exact module layout: a new `agent-projects.js` service plus a tool definition, wired through `team-bridge-actions.js` and dispatched in `team-bridge.js`.
- How the notice row and Telegram text are shaped, within the patterns named above.
- Test layout: unit tests for name validation and eligibility, plus an integration test for create, grant, coding and the notice. Also a native contract test against the pinned Gateway, if the existing contract suite covers new own tools the same way.

## Calls made by Claude, for the owner to check

- **The default folder only.** Even with `defaultCwd` unset, the parent is the home folder; a project folder directly in home is registered normally.
- **`git init` by default.**
- **Direct owner turns only.** No routines, hooks or forwarded content.
- **Leads and the owner's other own agents qualify;** team members, user agents and sender-facing agents do not.
- **Limit:** 10 new projects per agent per 24 hours.
- **No new agent powers.** The agent cannot delete, rename or unregister projects.
- **Narrow grant write.** The agent's grant is a narrow write (like SSH grants), so creating a project never cancels the agent's pending approvals.
- **Audit actor.** The audit log names the agent, not the owner, as the one who created the project.
- **Inside a repository.** If the default folder is inside a Git repository, the new folder must still be its own project. Otherwise creation is refused and nothing is left behind.
