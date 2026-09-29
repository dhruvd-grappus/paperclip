import { Router } from "express";
import type { Db } from "@paperclipai/db";
import type { AttentionSortMode } from "@paperclipai/shared";
import { attentionService } from "../services/attention.js";
import { waitingOnYouService } from "../services/waiting-on-you.js";
import { badRequest } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

/**
 * A repeatable, comma-separatable query parameter: `?user=a&user=b` and
 * `?user=a,b` both mean the same two values. Express hands the first shape
 * back as an array and the second as one string, and a multi-select has to
 * accept whichever the caller sent.
 */
function optionalQueryStringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const parsed = raw.flatMap((entry) => {
    if (typeof entry !== "string") throw badRequest(`${field} must be a string`);
    return entry.split(",");
  });
  const values = [...new Set(parsed.map((entry) => entry.trim()).filter(Boolean))];
  if (values.length === 0) throw badRequest(`${field} must name at least one value`);
  return values;
}

function optionalQueryString(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw badRequest(`${field} must be a non-empty string`);
  return value.trim();
}

export function attentionRoutes(db: Db) {
  const router = Router();
  const svc = attentionService(db);
  const waitingOnYou = waitingOnYouService(db);

  router.get("/companies/:companyId/attention", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }

    const includeDismissed = req.query.includeDismissed === "true";
    const archived = req.query.archived === "true";
    const all = req.query.all === "true";
    const activitySince = optionalQueryString(req.query.activitySince, "activitySince");
    const activityUntil = optionalQueryString(req.query.activityUntil, "activityUntil");
    const queue = optionalQueryString(req.query.queue, "queue");
    const cursor = optionalQueryString(req.query.cursor, "cursor");
    const sortValue = optionalQueryString(req.query.sort, "sort");
    if (sortValue !== undefined && sortValue !== "activity" && sortValue !== "decide") {
      throw badRequest("sort must be 'activity' or 'decide'");
    }
    const limitValue = optionalQueryString(req.query.limit, "limit");
    const limit = limitValue === undefined ? undefined : Number(limitValue);
    if (limit !== undefined && !Number.isInteger(limit)) throw badRequest("limit must be an integer");
    const feed = await svc.list(companyId, {
      userId: req.actor.userId,
      includeDismissed,
      archived,
      all,
      allowUnscopedAll: all,
      activitySince,
      activityUntil,
      queue,
      cursor,
      sort: sortValue as AttentionSortMode | undefined,
      limit,
    });
    res.json(feed);
  });

  /**
   * "Waiting on you" (GRA-328) — the desk list, built server-side. It lives
   * beside the attention feed because it is half made of it: the pending
   * questions and confirmations come from the same ranked queue, which is
   * scoped to the calling board user, so this endpoint carries the same board
   * requirement.
   *
   * `?user=` filters by the row's owner and `?project=` by its project; both
   * take any number of values (`?user=a&user=b` or `?user=a,b`) and the two
   * axes are ANDed. `user=unassigned` and `project=unfiled` are selectable
   * values for the rows with no owner and no project. The response always
   * reports the unfiltered owners, projects and total, so a picker keeps its
   * options after a filter narrows the list.
   */
  router.get("/companies/:companyId/waiting-on-you", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    if (!req.actor.userId) {
      res.status(403).json({ error: "Board user context required" });
      return;
    }
    const ownerUserIds = optionalQueryStringList(req.query.user, "user");
    const projectIds = optionalQueryStringList(req.query.project, "project");
    const feed = await waitingOnYou.list(companyId, {
      userId: req.actor.userId,
      ownerUserIds,
      projectIds,
    });
    res.json(feed);
  });

  return router;
}
