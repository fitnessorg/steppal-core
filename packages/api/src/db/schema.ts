import { relations } from "drizzle-orm";
import {
  pgTable,
  uuid,
  timestamp,
  text,
  integer,
  date,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Phase 2 schema.
 *
 * Two rules shape everything here:
 *
 * 1. A step count is a claim, not a fact. Rows in `stepDays` record what a
 *    phone reported and where it came from, never a number the server decided
 *    to believe. Validation lives in the ingest path, not in the column type.
 *
 * 2. Nothing is deleted. Pots end, memberships are left, tokens are revoked —
 *    all by timestamp. A settlement that cannot be reconstructed afterwards is
 *    a settlement nobody will trust.
 */

/**
 * Kept from Phase 1 so `/health` can prove the database is reachable and
 * writable, not merely that the process is up. Cheap, and it is the difference
 * between "the API responded" and "the API can serve a request".
 */
export const healthChecks = pgTable("health_checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  note: text("note").notNull().default("ok"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** E.164, the only identity in v1. No email, no password. */
    phone: text("phone").notNull(),
    displayName: text("display_name").notNull(),
    /** Seeds the generated avatar so a user looks the same everywhere. */
    avatarSeed: text("avatar_seed").notNull(),
    /** Personal daily target. Pots carry their own goal; this is the default. */
    dailyGoal: integer("daily_goal").notNull().default(10000),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_phone_idx").on(t.phone)],
);

/**
 * One-time codes for phone login.
 *
 * The code itself is never stored — only a hash — so a database leak cannot be
 * replayed into account takeovers. `attempts` caps guessing, and rows are kept
 * after use so a burst of requests to one number is visible.
 */
export const otpCodes = pgTable(
  "otp_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phone: text("phone").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("otp_codes_phone_created_idx").on(t.phone, t.createdAt)],
);

/**
 * Refresh tokens, hashed for the same reason OTPs are.
 *
 * One row per issued token. Rotating on use means a stolen token is only good
 * until the real device refreshes, at which point the theft is detectable.
 */
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("refresh_tokens_hash_idx").on(t.tokenHash),
    index("refresh_tokens_user_idx").on(t.userId),
  ],
);

/**
 * A pot is a week-long commitment between friends.
 *
 * `stakeKobo` is 0 for the money-free launch and is kept on the table so the
 * money release is a value change rather than a migration. `status` moves
 * forward only: open -> running -> settled.
 */
export const pots = pgTable(
  "pots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Short human-typable code, e.g. RUN-2290. */
    inviteCode: text("invite_code").notNull(),
    creatorId: uuid("creator_id")
      .notNull()
      .references(() => users.id),
    stakeKobo: integer("stake_kobo").notNull().default(0),
    dailyGoal: integer("daily_goal").notNull().default(10000),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    status: text("status", { enum: ["open", "running", "settled"] })
      .notNull()
      .default("open"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pots_invite_code_idx").on(t.inviteCode),
    index("pots_status_ends_idx").on(t.status, t.endsOn),
  ],
);

export const potMembers = pgTable(
  "pot_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    potId: uuid("pot_id")
      .notNull()
      .references(() => pots.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp("left_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("pot_members_pot_user_idx").on(t.potId, t.userId),
    index("pot_members_user_idx").on(t.userId),
  ],
);

/**
 * One row per user per calendar day — the unique index is what makes ingest
 * idempotent. A phone resending the same day overwrites its own row instead of
 * inflating a total, which matters because phones retry.
 *
 * `day` is a local calendar date, not an instant. Steps belong to the day the
 * walker experienced, not to a UTC window.
 */
export const stepDays = pgTable(
  "step_days",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    steps: integer("steps").notNull(),
    /** Where the number came from, kept for anti-cheat forensics. */
    source: text("source", { enum: ["health_connect", "pedometer", "mock"] })
      .notNull()
      .default("health_connect"),
    /** Steps reported before the daily cap was applied, when it was. */
    rawSteps: integer("raw_steps"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("step_days_user_day_idx").on(t.userId, t.day),
    index("step_days_day_idx").on(t.day),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(potMembers),
  stepDays: many(stepDays),
}));

export const potsRelations = relations(pots, ({ one, many }) => ({
  creator: one(users, { fields: [pots.creatorId], references: [users.id] }),
  members: many(potMembers),
}));

export const potMembersRelations = relations(potMembers, ({ one }) => ({
  pot: one(pots, { fields: [potMembers.potId], references: [pots.id] }),
  user: one(users, { fields: [potMembers.userId], references: [users.id] }),
}));

export const stepDaysRelations = relations(stepDays, ({ one }) => ({
  user: one(users, { fields: [stepDays.userId], references: [users.id] }),
}));

/**
 * The outcome of one member in one settled pot.
 *
 * Written once, when the pot settles, and never recomputed. Settlement reads
 * step_days at a moment in time; if a late sync arrives afterwards it does not
 * silently rewrite history. A result people can argue with is worse than a
 * result that is merely imperfect, so the number is frozen with its inputs.
 */
export const potResults = pgTable(
  "pot_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    potId: uuid("pot_id")
      .notNull()
      .references(() => pots.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Days in the pot window where the member met the daily goal. */
    daysHit: integer("days_hit").notNull(),
    daysPossible: integer("days_possible").notNull(),
    totalSteps: integer("total_steps").notNull(),
    /** Met the pot's terms: every day in the window. */
    metGoal: text("met_goal", { enum: ["yes", "no"] }).notNull(),
    /** Zero while stakes are zero. The column exists so money is a value change. */
    payoutKobo: integer("payout_kobo").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pot_results_pot_user_idx").on(t.potId, t.userId),
    index("pot_results_user_idx").on(t.userId),
  ],
);

export const potResultsRelations = relations(potResults, ({ one }) => ({
  pot: one(pots, { fields: [potResults.potId], references: [pots.id] }),
  user: one(users, { fields: [potResults.userId], references: [users.id] }),
}));
