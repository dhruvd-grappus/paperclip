import { randomUUID } from "node:crypto";
import request from "supertest";
import { expect, it } from "vitest";
import { issues } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

/**
 * GRA-632 — Reported problems are real issues that live in the backlog on the
 * Paperclip project, but the user explicitly does not want them to flood the
 * default board issue list, inbox, dashboard, or any other "normal view".
 * The fixer's pickup path is the dedicated /reported-problems page, which
 * calls a different endpoint. This test pins the default-exclude behaviour
 * and the opt-in via `?includeReportedProblems=true`.
 */

describeEmbeddedPostgres("issue list reported_problem default-hide", () => {
  const ctx = useEmbeddedPostgres(
    "paperclip-issues-list-reported-problems-default-hide-",
    { resetEach: resetCompanyIssueFixtures },
  );

  async function seedCompany() {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Reported problems hidden");
    const companyId = company.companyId;
    await ctx.db.insert(issues).values([
      {
        id: randomUUID(),
        companyId,
        title: "A normal todo",
        status: "todo",
        priority: "medium",
        originKind: "manual",
      },
      {
        id: randomUUID(),
        companyId,
        title: "A reported problem",
        status: "backlog",
        priority: "medium",
        originKind: "reported_problem",
      },
    ]);
    return { company, companyId };
  }

  async function listTitles(companyId: string, actor: unknown, query: string) {
    const res = await request(routeApp(ctx.db, actor as never, issueRoutes))
      .get(`/api/companies/${companyId}/issues${query}`)
      .expect(200);
    return (res.body as { title: string }[]).map((issue) => issue.title).sort();
  }

  it("hides reported_problem issues from the default issue list", async () => {
    const { company, companyId } = await seedCompany();
    expect(await listTitles(companyId, company.actor, "")).toEqual([
      "A normal todo",
    ]);
  });

  it("includes reported_problem issues when ?includeReportedProblems=true", async () => {
    const { company, companyId } = await seedCompany();
    expect(
      await listTitles(companyId, company.actor, "?includeReportedProblems=true"),
    ).toEqual(["A normal todo", "A reported problem"]);
  });

  it("surfaces reported_problem issues when filtered explicitly by originKind", async () => {
    const { company, companyId } = await seedCompany();
    expect(
      await listTitles(
        companyId,
        company.actor,
        "?originKind=reported_problem",
      ),
    ).toEqual(["A reported problem"]);
  });
});