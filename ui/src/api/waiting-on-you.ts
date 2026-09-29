import type { WaitingOnHumanRow } from "@paperclipai/shared";
import { api } from "./client";

export interface WaitingOnYouOwner {
  /** Null for the rows no person owns. */
  userId: string | null;
  count: number;
}

export interface WaitingOnYouFeed {
  companyId: string;
  items: WaitingOnHumanRow[];
  /** Owners present in the *unfiltered* list, so the picker keeps its options. */
  owners: WaitingOnYouOwner[];
  totalCount: number;
}

/** Owner filter value for the rows no person owns. Mirrors the server sentinel. */
export const WAITING_ON_YOU_UNASSIGNED = "unassigned";

export const waitingOnYouApi = {
  /**
   * The desk list, built server-side (GRA-328). The browser used to derive it
   * from the whole task list plus the whole attention feed; now it asks for
   * the rows, and the owner filter is applied where the rows are built.
   */
  list: (companyId: string, options: { user?: string | null } = {}) => {
    const params = new URLSearchParams();
    if (options.user) params.set("user", options.user);
    const query = params.toString();
    return api.get<WaitingOnYouFeed>(
      `/companies/${companyId}/waiting-on-you${query ? `?${query}` : ""}`,
    );
  },
};
