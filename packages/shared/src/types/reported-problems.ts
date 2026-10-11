export interface ReportedProblem {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  sourceIssueId: string | null;
  commentIds: string[];
  backlogIssueId: string | null;
  agentInstructionsRevisionId: string | null;
  agentInstructionsVersion: number | null;
  reportedByAgentId: string | null;
  reportedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReportedProblemByVersion {
  version: number | null;
  count: number;
  problems: ReportedProblem[];
}

export interface ReportedProblemCreateInput {
  title: string;
  description?: string;
  sourceIssueId?: string;
  commentIds?: string[];
}
