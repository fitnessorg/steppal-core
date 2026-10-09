# StepPal API

Base URL in development: `http://localhost:3000`

All endpoints return JSON. Authenticated endpoints expect
`Authorization: Bearer <accessToken>`; a missing or invalid token is `401`,
never `500`.

Money is in **kobo** throughout, as integers. Days are **local calendar dates**
written `YYYY-MM-DD`, never timestamps — a step belongs to the day the walker
lived, not to a UTC window.

## Auth

Phone numbers are normalised to E.164 before anything is stored, so
`08031234567`, `+234 803 123 4567` and `234-803-123-4567` are one account.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/auth/request-code` | — | Send a six-digit code by SMS |
| POST | `/v1/auth/verify-code` | — | Exchange the code for a session, creating the account on first use |
| POST | `/v1/auth/refresh` | — | Rotate the refresh token for a new pair |
| POST | `/v1/auth/logout` | — | Revoke one device's refresh token |
| GET | `/v1/me` | yes | The signed-in user |
| PATCH | `/v1/me` | yes | Change display name or personal daily goal |

**`POST /v1/auth/request-code`** — `{ phone }` → `{ ok: true, expiresInSeconds }`

Always `200` for a well-formed number, whether or not an account exists.
Answering differently would turn this endpoint into a way to discover who is
registered. `400` only for a number that cannot be parsed, `429` after five
requests to one number in an hour.

**`POST /v1/auth/verify-code`** — `{ phone, code, displayName? }` → `{ accessToken, refreshToken, user }`

Every failure is `401 invalid_code`. Expired, wrong, already-used and
never-issued are deliberately indistinguishable. Five wrong attempts burn the
code.

**`POST /v1/auth/refresh`** — `{ refreshToken }` → `{ accessToken, refreshToken }`

The presented token is revoked as it is accepted. A token used twice finds
nothing the second time, which is what makes theft detectable.

## Pots

A pot is a week-long commitment between 2 and 20 friends. `stakeKobo` is `0`
for the money-free launch; the column exists so enabling money is a value
change rather than a migration.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/pots` | yes | Create a pot and join it |
| GET | `/v1/pots` | yes | Pots you are in, newest first |
| GET | `/v1/pots/by-code/:code` | yes | Look a pot up without joining |
| POST | `/v1/pots/join` | yes | Join by invite code |
| GET | `/v1/pots/:id` | yes | Standings, and results once settled |
| POST | `/v1/pots/:id/leave` | yes | Leave, before it starts |

**`POST /v1/pots`** — `{ name, dailyGoal?, stakeKobo?, startsOn?, days? }` → `201 PotSummary`

Pot and creator membership are inserted in one transaction, so a pot with no
members cannot exist. The invite code is derived from the name — "Ikeja Early
Birds" becomes `IKEJ-2290` — so it is recognisable in a group chat with three
pots in it. Collisions retry against a unique index rather than being assumed
away.

**`GET /v1/pots/by-code/:code`** — accepts what a human types: lowercase, no
dash, stray spaces. Lets the app show "Ikeja Early Birds, 4 people" before
asking anyone to commit.

**`POST /v1/pots/join`** — `{ code }` → `PotSummary`

- `404 not_found` — no pot with that code
- `409 pot_settled` — it is over
- `409 pot_already_started` — joining late would mean competing on fewer days
- `409 pot_full` — 20 members

Joining a pot you are already in is a `200`, not an error. A double tap is not
a mistake worth punishing.

**`GET /v1/pots/:id`** — membership is the authorisation. Standings name
people, so holding the id is not enough; a non-member gets `403`.

**`POST /v1/pots/:id/leave`** — only before the pot starts (`409` after).
Otherwise anyone losing could walk away, and the commitment is gone.
Membership is timestamped rather than deleted, so the record survives.

## Steps

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/steps` | yes | Submit up to 31 days |
| GET | `/v1/steps` | yes | Read back what the server believes |

**`POST /v1/steps`** — `{ days: [{ day, steps, source }] }` → `{ accepted, clamped, rejected }`

The phone reports; the server decides. Three rules:

- **A future day is rejected.** Nobody has walked tomorrow, and accepting it
  would let a wrong clock bank a week ahead.
- **A day older than eight is rejected.** Backfill is for a phone that was
  offline, not for topping up a pot about to settle.
- **A count above `DAILY_STEP_CAP` (25,000) is clamped, not rejected**, and the
  original is kept in `raw_steps`. Clamping keeps an honest person with a
  pedometer glitch in the game while removing the benefit of shaking a phone
  for an hour, and the raw number means a reviewer can see what was claimed.

Writes are idempotent on `(user, day)`. Phones retry — on a flaky connection
they retry a lot — so a submission endpoint that is not idempotent is a
settlement bug waiting for a bad week of network.

Rejected days come back named, so the app can tell a user their clock is wrong
instead of quietly losing their steps.

## Settlement

Not an endpoint. `pnpm settle` runs `src/jobs/settle.ts`, intended for a daily
scheduler, and is safe to run as often as you like.

**The rule is not "most steps wins."** Most steps rewards whoever has the most
free time, which in a group of friends is the same person every week, and the
rest stop playing. Instead every member is judged against the same daily goal:
hit it *every day* of the window and you win. Everyone can win; everyone can
lose.

The forfeited stakes are split evenly among the winners. Integer kobo only —
the remainder from an uneven split goes to whoever walked the most, because it
has to go somewhere and money that silently vanishes is how a settlement loses
trust. **When nobody wins, stakes are returned**, never kept: StepPal does not
profit from a member failing, which matters ethically and keeps the product
clear of looking like a house taking a rake.

A pot settles the day *after* it ends, so the final day's steps have a full
night to sync from a phone that was asleep. Settling an already-settled pot
writes nothing and returns the stored result — the job will be retried, and
double-paying is unforgivable.

## Errors

```json
{ "error": "pot_already_started" }
```

Stable machine-readable codes, not prose. The SDK surfaces them as
`StepPalError { status, code }`.

## Environment

See `.env.example`. `SMS_PROVIDER=console` logs codes instead of sending them,
which is what makes the whole auth flow testable with no account anywhere.
`PAYMENT_PROVIDER=mock` is the default and the only one implemented.
