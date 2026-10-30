CREATE TABLE "access_decision_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"access_request_id" uuid NOT NULL,
	"request_revision" integer NOT NULL,
	"decision" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "access_decision_notifications_request_revision_key" UNIQUE("access_request_id","request_revision"),
	CONSTRAINT "access_decision_notifications_decision_check" CHECK ("access_decision_notifications"."decision" IN ('approved', 'denied')),
	CONSTRAINT "access_decision_notifications_state_check" CHECK ("access_decision_notifications"."state" IN ('pending', 'leased', 'sent', 'failed')),
	CONSTRAINT "access_decision_notifications_attempts_check" CHECK ("access_decision_notifications"."attempts" >= 0),
	CONSTRAINT "access_decision_notifications_revision_check" CHECK ("access_decision_notifications"."request_revision" > 0),
	CONSTRAINT "access_decision_notifications_lease_check" CHECK (("access_decision_notifications"."state" = 'leased' AND "access_decision_notifications"."lease_owner" IS NOT NULL AND "access_decision_notifications"."lease_expires_at" IS NOT NULL) OR ("access_decision_notifications"."state" <> 'leased' AND "access_decision_notifications"."lease_owner" IS NULL AND "access_decision_notifications"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "access_decision_prompts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"admin_principal_id" uuid NOT NULL,
	"access_request_id" uuid NOT NULL,
	"request_revision" integer NOT NULL,
	"action" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"prompt_message_id" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "access_decision_prompts_action_check" CHECK ("access_decision_prompts"."action" IN ('allow', 'deny')),
	CONSTRAINT "access_decision_prompts_state_check" CHECK ("access_decision_prompts"."state" IN ('pending', 'completed', 'cancelled', 'expired')),
	CONSTRAINT "access_decision_prompts_revision_check" CHECK ("access_decision_prompts"."request_revision" > 0),
	CONSTRAINT "access_decision_prompts_message_check" CHECK ("access_decision_prompts"."prompt_message_id" IS NULL OR "access_decision_prompts"."prompt_message_id" > 0)
);
--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "decision_note" text;--> statement-breakpoint
ALTER TABLE "access_decision_notifications" ADD CONSTRAINT "access_decision_notifications_request_fkey" FOREIGN KEY ("access_request_id") REFERENCES "public"."access_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_decision_prompts" ADD CONSTRAINT "access_decision_prompts_admin_fkey" FOREIGN KEY ("admin_principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_decision_prompts" ADD CONSTRAINT "access_decision_prompts_request_fkey" FOREIGN KEY ("access_request_id") REFERENCES "public"."access_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_decision_notifications_claim_idx" ON "access_decision_notifications" USING btree ("state","available_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "access_decision_prompts_one_pending_admin_idx" ON "access_decision_prompts" USING btree ("admin_principal_id") WHERE "access_decision_prompts"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "access_decision_prompts_expiry_idx" ON "access_decision_prompts" USING btree ("state","expires_at");