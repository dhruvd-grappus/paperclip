import type {
  ReportedProblem,
  ReportedProblemByVersion,
  ReportedProblemCreateInput,
} from "@paperclipai/shared";
import { api } from "./client";

export const reportedProblemsApi = {
  list: (companyId: string) =>
    api.get<ReportedProblem[]>(`/companies/${companyId}/reported-problems`),
  byVersion: (companyId: string) =>
    api.get<ReportedProblemByVersion[]>(`/companies/${companyId}/reported-problems/by-version`),
  create: (companyId: string, data: ReportedProblemCreateInput) =>
    api.post<ReportedProblem>(`/companies/${companyId}/reported-problems`, data),
};
