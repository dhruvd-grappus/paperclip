import { z } from "zod";

export const createReportedProblemSchema = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().max(20000).optional().default(""),
  sourceIssueId: z.string().uuid().optional().nullable(),
  commentIds: z.array(z.string().uuid()).max(100).optional().default([]),
});

export type CreateReportedProblem = z.infer<typeof createReportedProblemSchema>;
