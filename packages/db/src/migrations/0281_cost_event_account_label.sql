ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "account_label" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_events_company_account_occurred_idx" ON "cost_events" USING btree ("company_id","account_label","occurred_at");
