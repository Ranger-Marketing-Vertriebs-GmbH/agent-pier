import { Router } from "express";
import { decideReview, memoryReviews } from "../../features/assistants/memory-reviews.js";

// The owner's cards after a model switch's memory review (memory-reviews.js). Users
// have no route here; their app reads /api/me only.
export function assistantMemoryReviewRoutes({ assistants }) {
  const router = Router();
  router.get("/assistant-memory-reviews", (_req, res) =>
    res.json(memoryReviews(assistants)),
  );
  router.post("/assistant-memory-reviews/:id/decision", async (req, res) =>
    res.json(
      await decideReview(assistants, req.params.id, req.body, {
        kind: "owner",
        channel: "ui",
      }),
    ),
  );
  return router;
}
