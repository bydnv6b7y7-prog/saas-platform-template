CREATE TABLE "app_client_config" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"values" jsonb NOT NULL,
	"revision" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "app_client_config_singleton_check" CHECK ("app_client_config"."id" = 1),
	CONSTRAINT "app_client_config_revision_check" CHECK ("app_client_config"."revision" >= 1),
	CONSTRAINT "app_client_config_values_check" CHECK (jsonb_typeof("app_client_config"."values") = 'object')
);
--> statement-breakpoint
CREATE TABLE "app_client_config_audit" (
	"revision" integer PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	CONSTRAINT "app_client_config_audit_revision_check" CHECK ("app_client_config_audit"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "app_feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"installation_id" uuid NOT NULL,
	"user_id" text,
	"ip_hash" text NOT NULL,
	"category" text NOT NULL,
	"message" text NOT NULL,
	"contact" text,
	"context" text,
	"diagnostics" jsonb NOT NULL,
	"has_screenshot" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"handled_by" text,
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_feedback_status_check" CHECK ("app_feedback"."status" IN ('new', 'done')),
	CONSTRAINT "app_feedback_category_check" CHECK ("app_feedback"."category" IN ('bug', 'suggestion', 'other')),
	CONSTRAINT "app_feedback_context_check" CHECK ("app_feedback"."context" IS NULL OR "app_feedback"."context" IN ('purchaseFailed'))
);
--> statement-breakpoint
CREATE TABLE "app_feedback_screenshot" (
	"id" uuid PRIMARY KEY NOT NULL,
	"object_key" text NOT NULL,
	"installation_id" uuid NOT NULL,
	"ip_hash" text NOT NULL,
	"byte_length" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"feedback_id" uuid,
	"attached_at" timestamp with time zone,
	CONSTRAINT "app_feedback_screenshot_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "app_feedback_screenshot_feedback_id_unique" UNIQUE("feedback_id"),
	CONSTRAINT "app_feedback_screenshot_size_check" CHECK ("app_feedback_screenshot"."byte_length" BETWEEN 1 AND 1000000),
	CONSTRAINT "app_feedback_screenshot_attached_check" CHECK ("app_feedback_screenshot"."feedback_id" IS NULL OR "app_feedback_screenshot"."attached_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"impersonated_by" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" text PRIMARY KEY NOT NULL,
	"plan" text NOT NULL,
	"reference_id" text NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"status" text DEFAULT 'incomplete' NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"trial_start" timestamp with time zone,
	"trial_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false,
	"cancel_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"seats" integer,
	"billing_interval" text,
	"stripe_schedule_id" text
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"stripe_customer_id" text,
	"role" text DEFAULT 'user',
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "iap_account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bundle_id" text NOT NULL,
	"user_id" text,
	"app_account_token" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "iap_admin_action" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"bundle_id" text NOT NULL,
	"environment" text NOT NULL,
	"actor_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "iap_admin_action_environment" CHECK ("iap_admin_action"."environment" IN ('Production', 'Sandbox')),
	CONSTRAINT "iap_admin_action_status" CHECK ("iap_admin_action"."status" IN ('pending', 'accepted', 'failed', 'unknown')),
	CONSTRAINT "iap_admin_action_error_code" CHECK ("iap_admin_action"."error_code" IS NULL OR "iap_admin_action"."error_code" IN ('APPLE_REQUEST_REJECTED', 'APPLE_OUTCOME_UNKNOWN'))
);
--> statement-breakpoint
CREATE TABLE "iap_notification" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bundle_id" text NOT NULL,
	"environment" text NOT NULL,
	"notification_uuid" uuid NOT NULL,
	"type" text NOT NULL,
	"subtype" text,
	"signed_payload" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" uuid,
	"lease_expires_at" timestamp with time zone,
	"error_code" text,
	CONSTRAINT "iap_notification_environment" CHECK ("iap_notification"."environment" IN ('Production', 'Sandbox'))
);
--> statement-breakpoint
CREATE TABLE "iap_ownership_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bundle_id" text NOT NULL,
	"environment" text NOT NULL,
	"original_transaction_id" text NOT NULL,
	"from_user_id" text,
	"to_user_id" text NOT NULL,
	"ownership_version" integer NOT NULL,
	"expected_token" uuid,
	"target_token" uuid NOT NULL,
	"operator_user_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "iap_audit_environment" CHECK ("iap_ownership_audit"."environment" IN ('Production', 'Sandbox'))
);
--> statement-breakpoint
CREATE TABLE "iap_subscription" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bundle_id" text NOT NULL,
	"environment" text NOT NULL,
	"original_transaction_id" text NOT NULL,
	"user_id" text,
	"claimed_at" timestamp with time zone,
	"ownership_version" integer DEFAULT 0 NOT NULL,
	"snapshot" jsonb,
	"last_verified_at" timestamp with time zone,
	"verification_failed_at" timestamp with time zone,
	"last_error" text,
	"version" integer DEFAULT 0 NOT NULL,
	"lease_owner" uuid,
	"lease_expires_at" timestamp with time zone,
	"next_reconcile_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reconcile_attempts" integer DEFAULT 0 NOT NULL,
	"token_sync_mode" text,
	"token_sync_expected_token" uuid,
	"token_sync_target_token" uuid,
	"token_sync_ownership_version" integer,
	"token_sync_audit_id" uuid,
	"token_sync_state" text DEFAULT 'none' NOT NULL,
	"token_sync_attempts" integer DEFAULT 0 NOT NULL,
	"token_sync_next_attempt_at" timestamp with time zone,
	CONSTRAINT "iap_subscription_environment" CHECK ("iap_subscription"."environment" IN ('Production', 'Sandbox')),
	CONSTRAINT "iap_subscription_claimed" CHECK ("iap_subscription"."user_id" IS NULL OR "iap_subscription"."claimed_at" IS NOT NULL),
	CONSTRAINT "iap_subscription_transfer_audit" CHECK ("iap_subscription"."token_sync_mode" IS DISTINCT FROM 'transfer' OR "iap_subscription"."token_sync_audit_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "iap_sync_state" (
	"bundle_id" text NOT NULL,
	"environment" text NOT NULL,
	"window_start" timestamp with time zone,
	"window_end" timestamp with time zone,
	"pagination_token" text,
	"completed_through" timestamp with time zone,
	"coverage_gap_at" timestamp with time zone,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" uuid,
	"lease_expires_at" timestamp with time zone,
	"apple_next_request_at" timestamp with time zone DEFAULT now() NOT NULL,
	"apple_backoff_until" timestamp with time zone,
	CONSTRAINT "iap_sync_state_environment" CHECK ("iap_sync_state"."environment" IN ('Production', 'Sandbox'))
);
--> statement-breakpoint
CREATE TABLE "runtime_settings" (
	"scope" text PRIMARY KEY NOT NULL,
	"values" jsonb NOT NULL,
	"revision" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "runtime_settings_revision_check" CHECK ("runtime_settings"."revision" >= 1),
	CONSTRAINT "runtime_settings_values_check" CHECK (jsonb_typeof("runtime_settings"."values") = 'object')
);
--> statement-breakpoint
CREATE TABLE "runtime_settings_audit" (
	"scope" text NOT NULL,
	"revision" integer NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"before" jsonb NOT NULL,
	"after" jsonb NOT NULL,
	CONSTRAINT "runtime_settings_audit_scope_revision_pk" PRIMARY KEY("scope","revision"),
	CONSTRAINT "runtime_settings_audit_revision_check" CHECK ("runtime_settings_audit"."revision" >= 1),
	CONSTRAINT "runtime_settings_audit_before_check" CHECK (jsonb_typeof("runtime_settings_audit"."before") = 'object'),
	CONSTRAINT "runtime_settings_audit_after_check" CHECK (jsonb_typeof("runtime_settings_audit"."after") = 'object')
);
--> statement-breakpoint
CREATE TABLE "usage_buckets" (
	"subject_hash" text NOT NULL,
	"action" text NOT NULL,
	"window_seconds" integer NOT NULL,
	"bucket_started_at" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"cost_units" double precision DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "usage_buckets_subject_hash_action_window_seconds_bucket_started_at_pk" PRIMARY KEY("subject_hash","action","window_seconds","bucket_started_at"),
	CONSTRAINT "usage_buckets_values_check" CHECK ("usage_buckets"."window_seconds" > 0 AND "usage_buckets"."count" >= 0 AND "usage_buckets"."cost_units" >= 0)
);
--> statement-breakpoint
ALTER TABLE "app_feedback" ADD CONSTRAINT "app_feedback_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_feedback_screenshot" ADD CONSTRAINT "app_feedback_screenshot_feedback_id_app_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."app_feedback"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iap_account" ADD CONSTRAINT "iap_account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iap_subscription" ADD CONSTRAINT "iap_subscription_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iap_subscription" ADD CONSTRAINT "iap_subscription_token_sync_audit_id_iap_ownership_audit_id_fk" FOREIGN KEY ("token_sync_audit_id") REFERENCES "public"."iap_ownership_audit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_feedback_created_idx" ON "app_feedback" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "app_feedback_status_created_idx" ON "app_feedback" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "app_feedback_installation_created_idx" ON "app_feedback" USING btree ("installation_id","created_at");--> statement-breakpoint
CREATE INDEX "app_feedback_ip_created_idx" ON "app_feedback" USING btree ("ip_hash","created_at");--> statement-breakpoint
CREATE INDEX "app_feedback_screenshot_installation_created_idx" ON "app_feedback_screenshot" USING btree ("installation_id","created_at");--> statement-breakpoint
CREATE INDEX "app_feedback_screenshot_ip_created_idx" ON "app_feedback_screenshot" USING btree ("ip_hash","created_at");--> statement-breakpoint
CREATE INDEX "app_feedback_screenshot_created_idx" ON "app_feedback_screenshot" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "subscription_reference_id_idx" ON "subscription" USING btree ("reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_stripe_subscription_id_uidx" ON "subscription" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_stripe_customer_id_uidx" ON "user" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "iap_account_user_uidx" ON "iap_account" USING btree ("bundle_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "iap_account_token_uidx" ON "iap_account" USING btree ("bundle_id","app_account_token");--> statement-breakpoint
CREATE INDEX "iap_admin_action_scope_created_idx" ON "iap_admin_action" USING btree ("bundle_id","environment","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "iap_notification_uuid_uidx" ON "iap_notification" USING btree ("bundle_id","environment","notification_uuid");--> statement-breakpoint
CREATE INDEX "iap_notification_pending_idx" ON "iap_notification" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "iap_audit_version_uidx" ON "iap_ownership_audit" USING btree ("bundle_id","environment","original_transaction_id","ownership_version");--> statement-breakpoint
CREATE INDEX "iap_audit_chain_idx" ON "iap_ownership_audit" USING btree ("bundle_id","environment","original_transaction_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "iap_subscription_chain_uidx" ON "iap_subscription" USING btree ("bundle_id","environment","original_transaction_id");--> statement-breakpoint
CREATE INDEX "iap_subscription_user_idx" ON "iap_subscription" USING btree ("bundle_id","environment","user_id");--> statement-breakpoint
CREATE INDEX "iap_subscription_reconcile_idx" ON "iap_subscription" USING btree ("next_reconcile_at");--> statement-breakpoint
CREATE INDEX "iap_subscription_token_pending_idx" ON "iap_subscription" USING btree ("token_sync_next_attempt_at") WHERE "iap_subscription"."token_sync_state" IN ('pending', 'writing', 'verify_pending');--> statement-breakpoint
CREATE UNIQUE INDEX "iap_sync_state_scope_uidx" ON "iap_sync_state" USING btree ("bundle_id","environment");--> statement-breakpoint
CREATE INDEX "usage_buckets_expiry_idx" ON "usage_buckets" USING btree ("expires_at");