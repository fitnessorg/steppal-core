import { pgTable, uuid, timestamp, text } from "drizzle-orm/pg-core";

// Phase 1 placeholder table, replaced by the full schema in Phase 2.
// Exists so Drizzle Kit has something to generate a migration from and the
// health check has a real table to query against.
export const healthChecks = pgTable("health_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  note: text("note").notNull().default("ok"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
