CREATE TABLE "pot_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pot_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"days_hit" integer NOT NULL,
	"days_possible" integer NOT NULL,
	"total_steps" integer NOT NULL,
	"met_goal" text NOT NULL,
	"payout_kobo" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pot_results" ADD CONSTRAINT "pot_results_pot_id_pots_id_fk" FOREIGN KEY ("pot_id") REFERENCES "public"."pots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pot_results" ADD CONSTRAINT "pot_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pot_results_pot_user_idx" ON "pot_results" USING btree ("pot_id","user_id");--> statement-breakpoint
CREATE INDEX "pot_results_user_idx" ON "pot_results" USING btree ("user_id");