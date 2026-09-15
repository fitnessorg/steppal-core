#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, Address, Env,
};

const DAY: u64 = 24 * 60 * 60;

struct Fixture {
    env: Env,
    client: GoalEscrowClient<'static>,
    token: Address,
    token_admin: token::StellarAssetClient<'static>,
    token_client: token::Client<'static>,
    oracle: Address,
    walker: Address,
    sponsor: Address,
    tipper: Address,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    let token = sac.address();

    let contract_id = env.register(GoalEscrow, ());
    let client = GoalEscrowClient::new(&env, &contract_id);

    let f = Fixture {
        token_admin: token::StellarAssetClient::new(&env, &token),
        token_client: token::Client::new(&env, &token),
        oracle: Address::generate(&env),
        walker: Address::generate(&env),
        sponsor: Address::generate(&env),
        tipper: Address::generate(&env),
        env,
        client,
        token,
    };

    f.token_admin.mint(&f.sponsor, &1_000_000);
    f.token_admin.mint(&f.tipper, &1_000_000);
    f
}

fn advance(env: &Env, seconds: u64) {
    let now = env.ledger().timestamp();
    env.ledger().set_timestamp(now + seconds);
}

/// Sponsor funds a friend's goal, friend hits it, friend gets paid.
#[test]
fn sponsor_pays_out_when_goal_met() {
    let f = setup();
    let deadline = f.env.ledger().timestamp() + 7 * DAY;

    let id = f
        .client
        .create_goal(&f.walker, &f.oracle, &f.token, &70_000, &deadline);

    f.client.fund(&id, &f.sponsor, &50_000);
    assert_eq!(f.client.get_goal(&id).total, 50_000);

    advance(&f.env, 7 * DAY);
    f.client.attest(&id, &71_500);

    advance(&f.env, DAY + 1);
    let paid = f.client.claim(&id);

    assert_eq!(paid, 50_000);
    assert_eq!(f.token_client.balance(&f.walker), 50_000);
    assert_eq!(f.client.get_goal(&id).status, Status::Paid);
}

/// Several people tip one public pledge. All of it goes to the walker.
#[test]
fn many_tippers_all_pay_the_walker() {
    let f = setup();
    let deadline = f.env.ledger().timestamp() + 7 * DAY;

    let id = f
        .client
        .create_goal(&f.walker, &f.oracle, &f.token, &50_000, &deadline);

    f.client.fund(&id, &f.sponsor, &20_000);
    f.client.fund(&id, &f.tipper, &5_000);
    f.client.fund(&id, &f.tipper, &2_500); // tipping twice accumulates

    assert_eq!(f.client.funded_by(&id, &f.tipper), 7_500);

    advance(&f.env, 7 * DAY);
    f.client.attest(&id, &50_000); // exactly on target counts

    advance(&f.env, DAY + 1);
    assert_eq!(f.client.claim(&id), 27_500);
    assert_eq!(f.token_client.balance(&f.walker), 27_500);
}

/// Missed goal: nobody is paid, every funder takes back exactly their own money.
#[test]
fn missed_goal_refunds_each_funder_exactly() {
    let f = setup();
    let deadline = f.env.ledger().timestamp() + 7 * DAY;

    let id = f
        .client
        .create_goal(&f.walker, &f.oracle, &f.token, &70_000, &deadline);

    f.client.fund(&id, &f.sponsor, &30_000);
    f.client.fund(&id, &f.tipper, &10_000);

    advance(&f.env, 7 * DAY);
    f.client.attest(&id, &61_000); // short

    advance(&f.env, DAY + 1);
    assert_eq!(f.client.try_claim(&id), Err(Ok(Error::GoalNotMet)));

    assert_eq!(f.client.refund(&id, &f.sponsor), 30_000);
    assert_eq!(f.client.refund(&id, &f.tipper), 10_000);

    assert_eq!(f.token_client.balance(&f.sponsor), 1_000_000);
    assert_eq!(f.token_client.balance(&f.tipper), 1_000_000);
    assert_eq!(f.token_client.balance(&f.walker), 0);
}

/// A dispute inside the window stops the payout.
#[test]
fn dispute_blocks_claim_and_opens_refunds() {
    let f = setup();
    let deadline = f.env.ledger().timestamp() + 7 * DAY;

    let id = f
        .client
        .create_goal(&f.walker, &f.oracle, &f.token, &70_000, &deadline);
    f.client.fund(&id, &f.sponsor, &40_000);

    advance(&f.env, 7 * DAY);
    f.client.attest(&id, &99_999); // implausible

    f.client.dispute(&id, &f.tipper);

    advance(&f.env, DAY + 1);
    assert_eq!(f.client.try_claim(&id), Err(Ok(Error::NotAttested)));
    assert_eq!(f.client.refund(&id, &f.sponsor), 40_000);
}

/// Claiming before the challenge window closes is refused.
#[test]
fn cannot_claim_during_challenge_window() {
    let f = setup();
    let deadline = f.env.ledger().timestamp() + 7 * DAY;

    let id = f
        .client
        .create_goal(&f.walker, &f.oracle, &f.token, &10_000, &deadline);
    f.client.fund(&id, &f.sponsor, &5_000);

    advance(&f.env, 7 * DAY);
    f.client.attest(&id, &12_000);

    assert_eq!(f.client.try_claim(&id), Err(Ok(Error::ChallengeWindowOpen)));

    advance(&f.env, DAY + 1);
    assert_eq!(f.client.claim(&id), 5_000);
}

/// A silent oracle must never trap money.
#[test]
fn deadline_with_no_attestation_allows_refund() {
    let f = setup();
    let deadline = f.env.ledger().timestamp() + 7 * DAY;

    let id = f
        .client
        .create_goal(&f.walker, &f.oracle, &f.token, &70_000, &deadline);
    f.client.fund(&id, &f.sponsor, &25_000);

    advance(&f.env, 7 * DAY + 1);

    assert_eq!(f.client.refund(&id, &f.sponsor), 25_000);
    assert_eq!(f.token_client.balance(&f.sponsor), 1_000_000);
}

/// Paying twice must be impossible.
#[test]
fn claim_is_not_repeatable() {
    let f = setup();
    let deadline = f.env.ledger().timestamp() + 7 * DAY;

    let id = f
        .client
        .create_goal(&f.walker, &f.oracle, &f.token, &10_000, &deadline);
    f.client.fund(&id, &f.sponsor, &9_000);

    advance(&f.env, 7 * DAY);
    f.client.attest(&id, &11_000);
    advance(&f.env, DAY + 1);

    assert_eq!(f.client.claim(&id), 9_000);
    assert_eq!(f.client.try_claim(&id), Err(Ok(Error::AlreadyPaid)));
    assert_eq!(f.token_client.balance(&f.walker), 9_000);
}

/// Refunding twice must be impossible.
#[test]
fn refund_is_not_repeatable() {
    let f = setup();
    let deadline = f.env.ledger().timestamp() + 7 * DAY;

    let id = f
        .client
        .create_goal(&f.walker, &f.oracle, &f.token, &70_000, &deadline);
    f.client.fund(&id, &f.sponsor, &12_000);

    advance(&f.env, 7 * DAY + 1);
    assert_eq!(f.client.refund(&id, &f.sponsor), 12_000);
    assert_eq!(
        f.client.try_refund(&id, &f.sponsor),
        Err(Ok(Error::NothingToRefund))
    );
}

/// Funding after the deadline is refused.
#[test]
fn cannot_fund_after_deadline() {
    let f = setup();
    let deadline = f.env.ledger().timestamp() + DAY;

    let id = f
        .client
        .create_goal(&f.walker, &f.oracle, &f.token, &10_000, &deadline);

    advance(&f.env, DAY + 1);
    assert_eq!(
        f.client.try_fund(&id, &f.sponsor, &1_000),
        Err(Ok(Error::DeadlinePassed))
    );
}

/// Rubbish input is rejected at creation.
#[test]
fn rejects_bad_goals() {
    let f = setup();
    let deadline = f.env.ledger().timestamp() + DAY;

    assert_eq!(
        f.client
            .try_create_goal(&f.walker, &f.oracle, &f.token, &0, &deadline),
        Err(Ok(Error::TargetNotPositive))
    );

    let past = f.env.ledger().timestamp();
    assert_eq!(
        f.client
            .try_create_goal(&f.walker, &f.oracle, &f.token, &1_000, &past),
        Err(Ok(Error::DeadlinePassed))
    );
}

/// Zero or negative funding is rejected.
#[test]
fn rejects_non_positive_funding() {
    let f = setup();
    let deadline = f.env.ledger().timestamp() + DAY;
    let id = f
        .client
        .create_goal(&f.walker, &f.oracle, &f.token, &10_000, &deadline);

    assert_eq!(
        f.client.try_fund(&id, &f.sponsor, &0),
        Err(Ok(Error::AmountNotPositive))
    );
    assert_eq!(
        f.client.try_fund(&id, &f.sponsor, &-5),
        Err(Ok(Error::AmountNotPositive))
    );
}

/// Escrow must never hold money that belongs to nobody.
#[test]
fn contract_balance_is_conserved() {
    let f = setup();
    let deadline = f.env.ledger().timestamp() + 7 * DAY;
    let id = f
        .client
        .create_goal(&f.walker, &f.oracle, &f.token, &70_000, &deadline);

    f.client.fund(&id, &f.sponsor, &30_000);
    f.client.fund(&id, &f.tipper, &20_000);

    let escrow = f.client.address.clone();
    assert_eq!(f.token_client.balance(&escrow), 50_000);

    advance(&f.env, 7 * DAY);
    f.client.attest(&id, &80_000);
    advance(&f.env, DAY + 1);
    f.client.claim(&id);

    assert_eq!(f.token_client.balance(&escrow), 0);
    assert_eq!(f.token_client.balance(&f.walker), 50_000);
}
