CREATE TABLE "agent_instructions_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"entry_file" text DEFAULT 'AGENTS.md' NOT NULL,
	"content" text NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"source" text DEFAULT 'edit' NOT NULL,
	"rolled_back_from_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reported_problems" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"source_issue_id" uuid,
	"comment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"backlog_issue_id" uuid,
	"agent_instructions_revision_id" uuid,
	"agent_instructions_version" integer,
	"reported_by_agent_id" uuid,
	"reported_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_instructions_revisions" ADD CONSTRAINT "agent_instructions_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_instructions_revisions" ADD CONSTRAINT "agent_instructions_revisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_instructions_revisions" ADD CONSTRAINT "agent_instructions_revisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reported_problems" ADD CONSTRAINT "reported_problems_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reported_problems" ADD CONSTRAINT "reported_problems_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reported_problems" ADD CONSTRAINT "reported_problems_backlog_issue_id_issues_id_fk" FOREIGN KEY ("backlog_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reported_problems" ADD CONSTRAINT "reported_problems_agent_instructions_revision_id_agent_instructions_revisions_id_fk" FOREIGN KEY ("agent_instructions_revision_id") REFERENCES "public"."agent_instructions_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reported_problems" ADD CONSTRAINT "reported_problems_reported_by_agent_id_agents_id_fk" FOREIGN KEY ("reported_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_instructions_revisions_company_agent_version_uq" ON "agent_instructions_revisions" USING btree ("company_id","agent_id","version");--> statement-breakpoint
CREATE INDEX "agent_instructions_revisions_company_agent_created_idx" ON "agent_instructions_revisions" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_instructions_revisions_agent_created_idx" ON "agent_instructions_revisions" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "reported_problems_company_created_idx" ON "reported_problems" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "reported_problems_company_version_idx" ON "reported_problems" USING btree ("company_id","agent_instructions_version");--> statement-breakpoint
CREATE INDEX "reported_problems_source_issue_idx" ON "reported_problems" USING btree ("source_issue_id");--> statement-breakpoint
CREATE INDEX "reported_problems_backlog_issue_idx" ON "reported_problems" USING btree ("backlog_issue_id");