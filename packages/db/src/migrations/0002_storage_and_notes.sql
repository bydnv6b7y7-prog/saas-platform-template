CREATE TABLE "stored_object" (
	"id" uuid PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"user_id" text,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_length" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	CONSTRAINT "stored_object_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "stored_object_size_check" CHECK ("stored_object"."byte_length" > 0)
);
--> statement-breakpoint
CREATE TABLE "note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"attachment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "note_attachment_id_unique" UNIQUE("attachment_id")
);
--> statement-breakpoint
ALTER TABLE "stored_object" ADD CONSTRAINT "stored_object_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "note" ADD CONSTRAINT "note_attachment_id_stored_object_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."stored_object"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stored_object_user_purpose_idx" ON "stored_object" USING btree ("user_id","purpose");--> statement-breakpoint
CREATE INDEX "stored_object_created_idx" ON "stored_object" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "note_user_created_idx" ON "note" USING btree ("user_id","created_at");