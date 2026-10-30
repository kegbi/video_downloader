CREATE TABLE "access_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bridge" text NOT NULL,
	"external_user_id" text NOT NULL,
	"state" text NOT NULL,
	"request_count" integer DEFAULT 1 NOT NULL,
	"last_request_key" text NOT NULL,
	"notification_pending" boolean DEFAULT true NOT NULL,
	"first_requested_at" timestamp with time zone NOT NULL,
	"last_requested_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	CONSTRAINT "access_requests_bridge_external_user_id_key" UNIQUE("bridge","external_user_id"),
	CONSTRAINT "access_requests_bridge_check" CHECK ("access_requests"."bridge" = 'telegram'),
	CONSTRAINT "access_requests_external_user_id_check" CHECK ("access_requests"."external_user_id" ~ '^[0-9]+$'),
	CONSTRAINT "access_requests_state_check" CHECK ("access_requests"."state" IN ('pending', 'approved', 'denied')),
	CONSTRAINT "access_requests_request_count_check" CHECK ("access_requests"."request_count" > 0),
	CONSTRAINT "access_requests_last_request_key_check" CHECK (length("access_requests"."last_request_key") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_requests_pending_idx" ON "access_requests" USING btree ("state","notification_pending","last_requested_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "access_requests_retention_idx" ON "access_requests" USING btree ("resolved_at","last_requested_at");