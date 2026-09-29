import type { WaitingOnHumanRow } from "@paperclipai/shared";
import { api } from "./client";

export interface WaitingOnYouOwner {
  /** Null for the rows no person owns. */
  userId: string | null;
  count: number;
}

export interface WaitingOnYouProject {
  /** Null for the rows filed under no project. */
  projectId: string | null;
  count: number;
}

export interface WaitingOnYouFeed {
  companyId: string;
  items: WaitingOnHumanRow[];
  /** Owners present in the *unfiltered* list, so the picker keeps its options. */
  owners: WaitingOnYouOwner[];
  /** Projects present in the *unfiltered* list, for the same reason. */
  projects: WaitingOnYouProject[];
  totalCount: number;
}

/** Filter values for the rows with no owner / no project. Mirror the server's. */
export const WAITING_ON_YOU_UNASSIGNED = "unassigned";
export const WAITING_ON_YOU_UNFILED = "unfiled";

export const waitingOnYouApi = {
  /**
   * The desk list, built server-side (GRA-328). The browser used to derive it
   * from the whole task list plus the whole attention feed; now it asks for
   * the rows, and the owner and project filters are applied where the rows are
   * built. Both accept any number of values and are ANDed across axes.
   */
  list: (
    companyId: string,
    options: { users?: readonly string[]; projects?: readonly string[] } = {},
  ) => {
    // Repeated rather than comma-joined: an id is opaque, and a value that
    // ever contains a comma would silently split.
    const params = new URLSearchParams();
    for (const user of options.users ?? []) params.append("user", user);
    for (const project of options.projects ?? []) params.append("project", project);
    const query = params.toString();
    return api.get<WaitingOnYouFeed>(
      `/companies/${companyId}/waiting-on-you${query ? `?${query}` : ""}`,
    );
  },
};
