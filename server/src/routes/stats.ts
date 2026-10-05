import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { statsOverviewQuerySchema, statsRangeQuerySchema } from "@paperclipai/shared";
import { accessService, statsService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";
import { badRequest } from "../errors.js";

type StatsQuery = { from?: Date; to?: Date; projectId?: string };

function parseStatsQuery(
  schema: typeof statsOverviewQuerySchema | typeof statsRangeQuerySchema,
  query: Record<string, unknown>,
): StatsQuery {
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path?.[0] ? `'${String(issue.path[0])}'` : "query";
    throw badRequest(`invalid ${field} value${issue?.message ? `: ${issue.message}` : ""}`);
  }
  const value = parsed.data as { from?: string; to?: string; projectId?: string };
  return {
    from: value.from ? new Date(value.from) : undefined,
    to: value.to ? new Date(value.to) : undefined,
    projectId: value.projectId,
  };
}

export function statsRoutes(db: Db) {
  const router = Router();
  const stats = statsService(db);
  const access = accessService(db);

  // Same gate as the cost endpoints: company access, then the company-scope read
  // decision, so an agent key can never read another company's delivery numbers.
  async function assertCompanyStatsReadAllowed(
    req: Parameters<typeof assertCompanyAccess>[0],
    res: any,
    companyId: string,
  ) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Stats are outside this actor's authorization boundary" });
    return false;
  }

  router.get("/companies/:companyId/stats/overview", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyStatsReadAllowed(req, res, companyId))) return;
    const query = parseStatsQuery(statsOverviewQuerySchema, req.query);
    const overview = await stats.overview(companyId, query);
    res.json(overview);
  });

  router.get("/companies/:companyId/stats/by-project", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyStatsReadAllowed(req, res, companyId))) return;
    const query = parseStatsQuery(statsRangeQuerySchema, req.query);
    const rows = await stats.byProject(companyId, query);
    res.json(rows);
  });

  router.get("/companies/:companyId/stats/by-model", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyStatsReadAllowed(req, res, companyId))) return;
    const query = parseStatsQuery(statsRangeQuerySchema, req.query);
    res.json(await stats.byModel(companyId, query));
  });

  router.get("/companies/:companyId/stats/token-usage", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertCompanyStatsReadAllowed(req, res, companyId))) return;
    res.json(await stats.tokenUsage(companyId));
  });

  return router;
}
