import { z } from "zod";

/**
 * Query string of the stats endpoints. Express hands query values through as
 * strings (or arrays when a key repeats), so an absent key and an empty key
 * both mean "use the default range" and a repeated key is a bad request.
 */
const optionalTimestamp = z.preprocess(
  (value) => (value === "" || value == null ? undefined : value),
  z.union([z.string().datetime({ offset: true }), z.string().date()]).optional(),
);

const optionalProjectId = z.preprocess(
  (value) => (value === "" || value == null ? undefined : value),
  z.string().guid().optional(),
);

export const statsRangeQuerySchema = z
  .object({
    from: optionalTimestamp,
    to: optionalTimestamp,
  })
  .refine(
    (value) => !value.from || !value.to || new Date(value.from) <= new Date(value.to),
    { message: "'from' must not be after 'to'", path: ["from"] },
  );

export type StatsRangeQuery = z.infer<typeof statsRangeQuerySchema>;

export const statsOverviewQuerySchema = z
  .object({
    from: optionalTimestamp,
    to: optionalTimestamp,
    projectId: optionalProjectId,
  })
  .refine(
    (value) => !value.from || !value.to || new Date(value.from) <= new Date(value.to),
    { message: "'from' must not be after 'to'", path: ["from"] },
  );

export type StatsOverviewQuery = z.infer<typeof statsOverviewQuerySchema>;
