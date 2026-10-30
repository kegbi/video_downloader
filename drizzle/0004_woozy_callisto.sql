CREATE TABLE "access_request_notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"access_request_id" uuid NOT NULL,
	"admin_principal_id" uuid NOT NULL,
	"request_revision" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "access_request_notifications_request_admin_key" UNIQUE("access_request_id","admin_principal_id","request_revision"),
	CONSTRAINT "access_request_notifications_state_check" CHECK ("access_request_notifications"."state" IN ('pending', 'leased', 'sent', 'skipped', 'failed')),
	CONSTRAINT "access_request_notifications_attempts_check" CHECK ("access_request_notifications"."attempts" >= 0),
	CONSTRAINT "access_request_notifications_request_revision_check" CHECK ("access_request_notifications"."request_revision" > 0),
	CONSTRAINT "access_request_notifications_lease_check" CHECK (("access_request_notifications"."state" = 'leased' AND "access_request_notifications"."lease_owner" IS NOT NULL AND "access_request_notifications"."lease_expires_at" IS NOT NULL) OR ("access_request_notifications"."state" <> 'leased' AND "access_request_notifications"."lease_owner" IS NULL AND "access_request_notifications"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "access_requests" DROP CONSTRAINT "access_requests_external_user_id_check";--> statement-breakpoint
ALTER TABLE "principals" DROP CONSTRAINT "principals_external_user_id_check";--> statement-breakpoint
ALTER TABLE "access_requests" ADD COLUMN "notification_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "access_request_notifications" ADD CONSTRAINT "access_request_notifications_request_fkey" FOREIGN KEY ("access_request_id") REFERENCES "public"."access_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_request_notifications" ADD CONSTRAINT "access_request_notifications_admin_fkey" FOREIGN KEY ("admin_principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_request_notifications_claim_idx" ON "access_request_notifications" USING btree ("state","available_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "access_request_notifications_retention_idx" ON "access_request_notifications" USING btree ("updated_at");--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_notification_revision_check" CHECK ("access_requests"."notification_revision" > 0);--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_external_user_id_check" CHECK (("access_requests"."external_user_id" ~ '^[1-9][0-9]{0,14}$' OR ("access_requests"."external_user_id" ~ '^[1-9][0-9]{15}$' AND "access_requests"."external_user_id" <= '9007199254740991')));--> statement-breakpoint
ALTER TABLE "principals" ADD CONSTRAINT "principals_external_user_id_check" CHECK (("principals"."external_user_id" ~ '^[1-9][0-9]{0,14}$' OR ("principals"."external_user_id" ~ '^[1-9][0-9]{15}$' AND "principals"."external_user_id" <= '9007199254740991')));