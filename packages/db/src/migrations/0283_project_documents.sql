CREATE TABLE "project_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"key" text NOT NULL,
	"migrated_from_issue_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_documents" ADD CONSTRAINT "project_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_documents" ADD CONSTRAINT "project_documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_documents" ADD CONSTRAINT "project_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_documents_company_project_key_uq" ON "project_documents" USING btree ("company_id","project_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "project_documents_document_uq" ON "project_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "project_documents_company_project_updated_idx" ON "project_documents" USING btree ("company_id","project_id","updated_at");--> statement-breakpoint
CREATE INDEX "project_documents_migrated_from_issue_idx" ON "project_documents" USING btree ("company_id","migrated_from_issue_id");