ALTER TABLE "deliveries" ADD COLUMN "terminal_progress_state" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "terminal_progress_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "terminal_progress_lease_owner" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "terminal_progress_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "terminal_progress_next_attempt_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "deliveries_terminal_progress_claim_idx" ON "deliveries" USING btree ("terminal_progress_state","terminal_progress_next_attempt_at","terminal_progress_lease_expires_at");--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_terminal_progress_state_check" CHECK ("deliveries"."terminal_progress_state" IS NULL OR "deliveries"."terminal_progress_state" IN ('failed', 'cancelled', 'expired'));--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_terminal_progress_attempts_check" CHECK ("deliveries"."terminal_progress_attempts" >= 0);--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_terminal_progress_lease_check" CHECK (("deliveries"."terminal_progress_lease_owner" IS NULL AND "deliveries"."terminal_progress_lease_expires_at" IS NULL) OR ("deliveries"."terminal_progress_lease_owner" IS NOT NULL AND "deliveries"."terminal_progress_lease_expires_at" IS NOT NULL));