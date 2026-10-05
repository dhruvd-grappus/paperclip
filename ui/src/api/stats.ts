import type { StatsByModel, StatsByProject, StatsOverview, StatsTokenUsage } from "@paperclipai/shared";
import { api } from "./client";

function statsParams(from?: string, to?: string, projectId?: string): string {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (projectId) params.set("projectId", projectId);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const statsApi = {
  overview: (companyId: string, from?: string, to?: string, projectId?: string) =>
    api.get<StatsOverview>(`/companies/${companyId}/stats/overview${statsParams(from, to, projectId)}`),
  byProject: (companyId: string, from?: string, to?: string) =>
    api.get<StatsByProject>(`/companies/${companyId}/stats/by-project${statsParams(from, to)}`),
  byModel: (companyId: string, from?: string, to?: string) =>
    api.get<StatsByModel>(`/companies/${companyId}/stats/by-model${statsParams(from, to)}`),
  tokenUsage: (companyId: string) =>
    api.get<StatsTokenUsage>(`/companies/${companyId}/stats/token-usage`),
};
