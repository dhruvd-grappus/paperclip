ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "completion_evidence_policy" jsonb DEFAULT '{"enabled":false,"scope":"all","require":"either","countDescendants":true}'::jsonb NOT NULL;
