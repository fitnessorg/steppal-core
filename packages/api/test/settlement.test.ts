import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildApp } from "../src/app.js";
import { queryClient } from "../src/db/client.js";
import { auth, reset, signIn, submitSteps, type Session } from "./helpers.js";
import { addDays, daysBetween, todayKey } from "../src/lib/dates.js";
import { settleDuePots, settlePot } from "../src/lib/settlement.js";

const ADA = "08031234567";
const TUNDE = "08039998888";
const BISI = "08037776666";

/**
 * A pot that ran for three days and closed yesterday.
 *
 * Built forwards and then backdated in SQL, because the join endpoint
 * deliberately refuses a pot that has already started — which is the behaviour
 * under test elsewhere, so it is not worked around in the route.
 */
async function finishedPot(
  app: ReturnType<typeof buildApp>,
  owner: Session,
  others: Session[] = [],
  stakeKobo = 0,
) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/pots",
    headers: auth(owner),
    payload: { name: "Settled Pot", dailyGoal: 8000, stakeKobo, days: 3 },
  });
  const created = res.json();

  for (const who of others) {
    await app.inject({
      method: "POST",
      url: "/v1/pots/join",
      headers: auth(who),
      payload: { code: created.inviteCode },
    });
  }

  const startsOn = addDays(todayKey(), -3);
  const endsOn = addDays(todayKey(), -1);
  await queryClient`update pots set starts_on = ${startsOn}, ends_on = ${endsOn}, status = 'running' where id = ${created.id}`;

  const pot = { ...created, startsOn, endsOn };
  return { pot, window: daysBetween(startsOn, endsOn) };
}

describe("settlement", () => {
  beforeEach(reset);
  afterAll(async () => {
    await queryClient.end();
  });

  it("pays the forfeited stakes to everyone who met the goal every day", async () => {
    const app = buildApp();
    const ada = await signIn(app, ADA);
    const tunde = await signIn(app, TUNDE);

    const { pot, window } = await finishedPot(app, ada, [tunde], 300_000);

    await submitSteps(app, ada, window, 9000); // hit every day
    await submitSteps(app, tunde, window, 2000); // missed every day

    const result = (await settlePot(pot.id))!;

    expect(result.winners).toEqual([ada.user.id]);
    expect(result.losers).toEqual([tunde.user.id]);
    // Ada gets her own stake back plus Tunde's forfeited one.
    expect(result.payouts.find((p) => p.userId === ada.user.id)!.payoutKobo).toBe(600_000);
    expect(result.payouts.find((p) => p.userId === tunde.user.id)!.payoutKobo).toBe(0);

    await app.close();
  });

  it("misses a single day and that is a loss — the goal is every day", async () => {
    const app = buildApp();
    const ada = await signIn(app, ADA);

    const { pot, window } = await finishedPot(app, ada, [], 100_000);

    await submitSteps(app, ada, window.slice(0, 2), 9000);
    await submitSteps(app, ada, window.slice(2), 500);

    const result = (await settlePot(pot.id))!;

    expect(result.winners).toHaveLength(0);
    // Nobody won, so stakes come back rather than being kept.
    expect(result.payouts[0]!.payoutKobo).toBe(100_000);

    await app.close();
  });

  it("splits the forfeit pot evenly and gives the remainder to the top walker", async () => {
    const app = buildApp();
    const ada = await signIn(app, ADA);
    const tunde = await signIn(app, TUNDE);
    const bisi = await signIn(app, BISI);

    // One loser's 1001 kobo cannot divide evenly between two winners.
    const { pot, window } = await finishedPot(app, ada, [tunde, bisi], 1001);

    await submitSteps(app, ada, window, 20000); // winner, most steps
    await submitSteps(app, tunde, window, 9000); // winner
    await submitSteps(app, bisi, window, 100); // loser

    const result = (await settlePot(pot.id))!;
    const total = result.payouts.reduce((sum, p) => sum + p.payoutKobo, 0);

    expect(result.winners).toHaveLength(2);
    // Every kobo staked is paid out. None is lost to rounding, none invented.
    expect(total).toBe(3 * 1001);
    expect(result.payouts.find((p) => p.userId === ada.user.id)!.payoutKobo).toBe(
      1001 + 500 + 1,
    );

    await app.close();
  });

  it("is idempotent — settling twice does not pay twice", async () => {
    const app = buildApp();
    const ada = await signIn(app, ADA);
    const { pot, window } = await finishedPot(app, ada, [], 50_000);
    await submitSteps(app, ada, window, 9000);

    const first = (await settlePot(pot.id))!;
    const second = (await settlePot(pot.id))!;

    expect(second.payouts).toEqual(first.payouts);

    const rows = await queryClient`select count(*)::int as n from pot_results`;
    expect(rows[0]!.n).toBe(1);

    await app.close();
  });

  it("will not settle a pot whose last day has not finished", async () => {
    const app = buildApp();
    const ada = await signIn(app, ADA);

    const res = await app.inject({
      method: "POST",
      url: "/v1/pots",
      headers: auth(ada),
      payload: { name: "Still Running", days: 7 },
    });

    expect(await settlePot(res.json().id)).toBeNull();

    await app.close();
  });

  it("settleDuePots picks up only the pots that have closed", async () => {
    const app = buildApp();
    const ada = await signIn(app, ADA);

    const { pot, window } = await finishedPot(app, ada);
    await submitSteps(app, ada, window, 9000);

    await app.inject({
      method: "POST",
      url: "/v1/pots",
      headers: auth(ada),
      payload: { name: "Not Due Yet", days: 7 },
    });

    const settled = await settleDuePots();

    expect(settled.map((s) => s.potId)).toEqual([pot.id]);

    await app.close();
  });

  it("shows results on the pot once it has settled", async () => {
    const app = buildApp();
    const ada = await signIn(app, ADA);
    const { pot, window } = await finishedPot(app, ada);
    await submitSteps(app, ada, window, 9000);
    await settlePot(pot.id);

    const res = await app.inject({
      method: "GET",
      url: `/v1/pots/${pot.id}`,
      headers: auth(ada),
    });

    expect(res.json().status).toBe("settled");
    expect(res.json().results).toHaveLength(1);
    expect(res.json().results[0].metGoal).toBe(true);
    expect(res.json().results[0].daysPossible).toBe(3);

    await app.close();
  });
});
