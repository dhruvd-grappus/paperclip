import { z } from "zod";
import {
  COMPLETION_EVIDENCE_REQUIREMENTS,
  COMPLETION_EVIDENCE_SCOPES,
  DEFAULT_COMPLETION_EVIDENCE_POLICY,
} from "../completion-evidence.js";
import {
  COMPANY_STATUSES,
  ISSUE_THREAD_INTERACTION_RESOLVER_POLICIES,
} from "../constants.js";
import { objectWithoutDefaults } from "./partial.js";

const logoAssetIdSchema = z.string().guid().nullable().optional();
const feedbackDataSharingTermsVersionSchema = z.string().min(1).nullable().optional();

const interactionResolverKindGovernanceSchema = z.object({
  defaultPolicy: z.enum(ISSUE_THREAD_INTERACTION_RESOLVER_POLICIES).optional(),
  cap: z.enum(ISSUE_THREAD_INTERACTION_RESOLVER_POLICIES).optional(),
}).strict();

export const interactionResolverGovernanceSchema = z.object({
  suggest_tasks: interactionResolverKindGovernanceSchema.optional(),
  ask_user_questions: interactionResolverKindGovernanceSchema.optional(),
  request_confirmation: interactionResolverKindGovernanceSchema.optional(),
  request_checkbox_confirmation: interactionResolverKindGovernanceSchema.optional(),
  request_item_verdicts: interactionResolverKindGovernanceSchema.optional(),
}).strict().default({});

/**
 * The completion gate, as stored on a company.
 *
 * Every field is required once the object is supplied: a partial policy would
 * leave the gate half-specified, and "enabled with no scope" has no safe
 * reading. Callers send the whole object, which is also what the settings form
 * does. Rows written before this column existed parse through
 * {@link completionEvidencePolicyFromStorage}.
 */
export const completionEvidencePolicySchema = z
  .object({
    enabled: z.boolean(),
    scope: z.enum(COMPLETION_EVIDENCE_SCOPES),
    require: z.enum(COMPLETION_EVIDENCE_REQUIREMENTS),
    countDescendants: z.boolean(),
  })
  .strict();

/**
 * Read a stored policy, falling back to the shipped default.
 *
 * The column defaults to `{}` for rows that predate it, and a malformed value
 * must not make a task uncompletable — failing open is the right direction for
 * a gate whose whole purpose is to be turned on deliberately.
 */
export function completionEvidencePolicyFromStorage(value: unknown) {
  const parsed = completionEvidencePolicySchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_COMPLETION_EVIDENCE_POLICY;
}

export const createCompanySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  defaultResponsibleUserId: z.string().min(1).nullable().optional(),
});

export type CreateCompany = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = objectWithoutDefaults(
  createCompanySchema
    .partial()
    .extend({
      status: z.enum(COMPANY_STATUSES).optional(),
      spentMonthlyCents: z.number().int().nonnegative().optional(),
      requireBoardApprovalForNewAgents: z.boolean().optional(),
      interactionResolverGovernance: interactionResolverGovernanceSchema.optional(),
      completionEvidencePolicy: completionEvidencePolicySchema.optional(),
      feedbackDataSharingEnabled: z.boolean().optional(),
      feedbackDataSharingConsentAt: z.coerce.date().nullable().optional(),
      feedbackDataSharingConsentByUserId: z.string().min(1).nullable().optional(),
      feedbackDataSharingTermsVersion: feedbackDataSharingTermsVersionSchema,
      logoAssetId: logoAssetIdSchema,
    }),
);

export type UpdateCompany = z.infer<typeof updateCompanySchema>;

export const updateCompanyBrandingSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    logoAssetId: logoAssetIdSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined
      || value.description !== undefined
      || value.logoAssetId !== undefined,
    "At least one branding field must be provided",
  );

export type UpdateCompanyBranding = z.infer<typeof updateCompanyBrandingSchema>;
