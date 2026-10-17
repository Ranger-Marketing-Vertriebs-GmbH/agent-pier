import { Router } from "express";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { remoteTransport, wantsRemotes } from "../../features/repositories/git-remote.js";

export function repositoriesRoutes(services) {
  const { repositories, github, gitRemotes, sessions } = services;
  const router = Router();
  // A created, rotated or deleted profile reaches the agents using it (agent-github.js);
  // their shell folders were already updated by github.sync().
  // Not awaited: the Gateway converges in the background, under admission.
  const agents = () => {
    const assistants = services.assistants;
    const agentGithub = assistants?.workflows?.github;
    if (agentGithub) assistants.admit(() => agentGithub.refresh()).catch(() => {});
  };
  router.get("/repositories", async (req, res) => {
    const projects = repositories.listProjects();
    res.json({
      credentials: repositories.listCredentials(),
      projects:
        gitRemotes && wantsRemotes(req)
          ? await gitRemotes.annotate(projects, "path")
          : projects,
    });
  });
  router.post("/git-credentials", async (req, res) => {
    const credential = repositories.createCredential(req.body);
    await github.sync();
    agents();
    res.status(201).json(credential);
  });
  router.patch("/git-credentials/:id", async (req, res) => {
    const credential = repositories.updateCredential(req.params.id, req.body);
    await github.sync();
    agents();
    res.json(credential);
  });
  // Calls the host's API with the saved token; the response carries only the result.
  router.post("/git-credentials/:id/check", async (req, res) => {
    const credential = await repositories.checkCredential(req.params.id);
    if (!credential) throw problem(serverMessages.repositories.profileChanged, 409);
    res.json(credential);
  });
  router.get("/sessions/:id/github", async (req, res) => {
    const session = await sessions.get(req.params.id);
    const remote = gitRemotes
      ? remoteTransport(await gitRemotes.read(session.cwd))
      : null;
    res.json({ ...github.status(session.id), remote });
  });
  router.delete("/git-credentials/:id", async (req, res) => {
    repositories.removeCredential(req.params.id);
    await github.sync();
    agents();
    res.status(204).end();
  });
  router.post("/repositories/clone", async (req, res) =>
    res.status(201).json(await repositories.clone(req.body)),
  );
  router.get("/repositories/discover", async (req, res) =>
    res.json(
      await repositories.discover({
        credentialId: req.query.credentialId,
        query: req.query.q,
        organization: req.query.organization,
        page: req.query.page,
      }),
    ),
  );
  return router;
}
