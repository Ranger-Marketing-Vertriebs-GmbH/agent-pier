import { Router } from "express";

/**
 * The owner's project groups of the projects page. Every answer is the whole current
 * document (`version`, `groups`, `assignments`); a write based on an older version is
 * refused with 409, the same document and the code PROJECT_GROUP_CONFLICT.
 */
export function projectGroupsRoutes({ projectGroups }) {
  const router = Router();
  router.get("/project-groups", (_req, res) => res.json(projectGroups.get()));
  router.put("/project-groups", (req, res) => {
    try {
      res.json(projectGroups.replace(req.body));
    } catch (error) {
      if (error.code !== "PROJECT_GROUP_CONFLICT") throw error;
      res.status(409).json({
        ...projectGroups.get(),
        code: error.code,
        error: error.message,
      });
    }
  });
  return router;
}
