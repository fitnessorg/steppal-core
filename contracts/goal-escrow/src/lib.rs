#![no_std]

//! StepPal goal escrow.
//!
//! One primitive serves three product features, because all three are the same
//! shape: money locked against a step goal, released only if an attested result
//! meets it.
//!
//! * **Sponsor a friend.** One funder, one beneficiary. Hit the goal, take the
//!   money.
//! * **Tip a pledge.** A public goal anyone can add to. Same release rule, many
//!   funders.
//! * **A pot.** Every member is both funder and beneficiary of their own goal.
//!
//! Design notes worth knowing before you read the code:
//!
//! * The contract cannot see step counts. An off-chain oracle attests them.
//!   That makes this **trust-minimised, not trustless** — and the challenge
//!   window below is what bounds the oracle's power.
//! * A wrong or missing attestation never traps funds. After `deadline`, or
//!   after a successful dispute, every funder can pull their own money back.
//! * Funders are refunded exactly what they put in. No pro-rata maths, so no
//!   rounding dust and no way for the last claimant to be short-changed.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, Env, Map, Symbol,
};

/// How long after an attestation anyone may dispute, in seconds.
const CHALLENGE_WINDOW: u64 = 24 * 60 * 60;

#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Status {
    /// Accepting funds.
    Open,
    /// Oracle has attested. Challenge window running.
    Attested,
    /// Goal met and paid out.
    Paid,
    /// Disputed, or deadline passed unattested. Funders may withdraw.
    Refunding,
}

#[contracttype]
#[derive(Clone)]
pub struct Goal {
    pub beneficiary: Address,
    pub oracle: Address,
    pub token: Address,
    /// Steps the beneficiary must reach.
    pub target_steps: u32,
    /// Funding and attestation must both happen before this ledger time.
    pub deadline: u64,
    pub status: Status,
    /// Total currently escrowed.
    pub total: i128,
    /// Steps the oracle attested. Zero until attested.
    pub attested_steps: u32,
    /// When the challenge window closes. Zero until attested.
    pub challenge_ends: u64,
}

#[contracttype]
pub enum DataKey {
    /// Next goal id to hand out.
    NextId,
    /// Goal by id.
    Goal(u32),
    /// Per-goal record of who funded how much, so refunds are exact.
    Funders(u32),
}

#[contracterror]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum Error {
    GoalNotFound = 1,
    NotOpen = 2,
    NotAttested = 3,
    NotRefunding = 4,
    DeadlinePassed = 5,
    DeadlineNotPassed = 6,
    ChallengeWindowOpen = 7,
    ChallengeWindowClosed = 8,
    GoalNotMet = 9,
    NothingToRefund = 10,
    AmountNotPositive = 11,
    TargetNotPositive = 12,
    AlreadyPaid = 13,
}

#[contract]
pub struct GoalEscrow;

#[contractimpl]
impl GoalEscrow {
    /// Creates a goal. Anyone may create one for any beneficiary — sponsoring a
    /// friend is the normal case, so no authorisation from the beneficiary is
    /// required to *give* them money.
    pub fn create_goal(
        env: Env,
        beneficiary: Address,
        oracle: Address,
        token: Address,
        target_steps: u32,
        deadline: u64,
    ) -> Result<u32, Error> {
        if target_steps == 0 {
            return Err(Error::TargetNotPositive);
        }
        if deadline <= env.ledger().timestamp() {
            return Err(Error::DeadlinePassed);
        }

        let id: u32 = env.storage().instance().get(&DataKey::NextId).unwrap_or(0);
        env.storage().instance().set(&DataKey::NextId, &(id + 1));

        let goal = Goal {
            beneficiary,
            oracle,
            token,
            target_steps,
            deadline,
            status: Status::Open,
            total: 0,
            attested_steps: 0,
            challenge_ends: 0,
        };

        env.storage().persistent().set(&DataKey::Goal(id), &goal);
        env.storage()
            .persistent()
            .set(&DataKey::Funders(id), &Map::<Address, i128>::new(&env));
        Self::bump(&env, id);

        env.events()
            .publish((Symbol::new(&env, "goal_created"), id), target_steps);
        Ok(id)
    }

    /// Adds money to a goal. Sponsors and tippers use the same call.
    pub fn fund(env: Env, id: u32, funder: Address, amount: i128) -> Result<(), Error> {
        funder.require_auth();

        if amount <= 0 {
            return Err(Error::AmountNotPositive);
        }

        let mut goal = Self::load(&env, id)?;
        if goal.status != Status::Open {
            return Err(Error::NotOpen);
        }
        if env.ledger().timestamp() >= goal.deadline {
            return Err(Error::DeadlinePassed);
        }

        token::Client::new(&env, &goal.token).transfer(
            &funder,
            &env.current_contract_address(),
            &amount,
        );

        let mut funders: Map<Address, i128> = env
            .storage()
            .persistent()
            .get(&DataKey::Funders(id))
            .unwrap();
        let prior = funders.get(funder.clone()).unwrap_or(0);
        funders.set(funder.clone(), prior + amount);

        goal.total += amount;

        env.storage().persistent().set(&DataKey::Goal(id), &goal);
        env.storage()
            .persistent()
            .set(&DataKey::Funders(id), &funders);
        Self::bump(&env, id);

        env.events()
            .publish((Symbol::new(&env, "funded"), id, funder), amount);
        Ok(())
    }

    /// Oracle reports the step count. Opens the challenge window.
    ///
    /// Attesting a result below target is allowed and useful: it moves the goal
    /// to `Refunding` immediately rather than making funders wait for the
    /// deadline.
    pub fn attest(env: Env, id: u32, steps: u32) -> Result<(), Error> {
        let mut goal = Self::load(&env, id)?;
        goal.oracle.require_auth();

        if goal.status != Status::Open {
            return Err(Error::NotOpen);
        }

        goal.attested_steps = steps;
        goal.status = Status::Attested;
        goal.challenge_ends = env.ledger().timestamp() + CHALLENGE_WINDOW;

        env.storage().persistent().set(&DataKey::Goal(id), &goal);
        Self::bump(&env, id);

        env.events()
            .publish((Symbol::new(&env, "attested"), id), steps);
        Ok(())
    }

    /// Anyone may dispute during the challenge window. A dispute always sends
    /// the goal to `Refunding`: money goes back to whoever put it in.
    ///
    /// Deliberately permissionless and bond-free. The worst a griefer achieves
    /// is that everyone gets their own money back.
    pub fn dispute(env: Env, id: u32, challenger: Address) -> Result<(), Error> {
        challenger.require_auth();

        let mut goal = Self::load(&env, id)?;
        if goal.status != Status::Attested {
            return Err(Error::NotAttested);
        }
        if env.ledger().timestamp() >= goal.challenge_ends {
            return Err(Error::ChallengeWindowClosed);
        }

        goal.status = Status::Refunding;
        env.storage().persistent().set(&DataKey::Goal(id), &goal);
        Self::bump(&env, id);

        env.events()
            .publish((Symbol::new(&env, "disputed"), id), challenger);
        Ok(())
    }

    /// Pays the beneficiary. Permissionless once the window closes, so nobody
    /// waits on the app's server to get paid.
    pub fn claim(env: Env, id: u32) -> Result<i128, Error> {
        let mut goal = Self::load(&env, id)?;

        match goal.status {
            Status::Paid => return Err(Error::AlreadyPaid),
            Status::Attested => {}
            _ => return Err(Error::NotAttested),
        }

        if env.ledger().timestamp() < goal.challenge_ends {
            return Err(Error::ChallengeWindowOpen);
        }
        if goal.attested_steps < goal.target_steps {
            return Err(Error::GoalNotMet);
        }

        let payout = goal.total;
        goal.status = Status::Paid;
        goal.total = 0;

        env.storage().persistent().set(&DataKey::Goal(id), &goal);
        Self::bump(&env, id);

        token::Client::new(&env, &goal.token).transfer(
            &env.current_contract_address(),
            &goal.beneficiary,
            &payout,
        );

        env.events()
            .publish((Symbol::new(&env, "claimed"), id), payout);
        Ok(payout)
    }

    /// Withdraws one funder's own contribution.
    ///
    /// Works once the goal is refunding, or once the deadline has passed with
    /// no attestation. That second case is what guarantees a silent oracle can
    /// never trap funds.
    pub fn refund(env: Env, id: u32, funder: Address) -> Result<i128, Error> {
        funder.require_auth();

        let mut goal = Self::load(&env, id)?;
        let now = env.ledger().timestamp();

        let refundable = match goal.status {
            Status::Refunding => true,
            Status::Open => now >= goal.deadline,
            Status::Attested => {
                now >= goal.challenge_ends && goal.attested_steps < goal.target_steps
            }
            Status::Paid => false,
        };
        if !refundable {
            return Err(Error::NotRefunding);
        }

        let mut funders: Map<Address, i128> = env
            .storage()
            .persistent()
            .get(&DataKey::Funders(id))
            .unwrap();
        let owed = funders.get(funder.clone()).unwrap_or(0);
        if owed <= 0 {
            return Err(Error::NothingToRefund);
        }

        funders.set(funder.clone(), 0);
        goal.total -= owed;
        goal.status = Status::Refunding;

        env.storage().persistent().set(&DataKey::Goal(id), &goal);
        env.storage()
            .persistent()
            .set(&DataKey::Funders(id), &funders);
        Self::bump(&env, id);

        token::Client::new(&env, &goal.token).transfer(
            &env.current_contract_address(),
            &funder,
            &owed,
        );

        env.events()
            .publish((Symbol::new(&env, "refunded"), id, funder), owed);
        Ok(owed)
    }

    pub fn get_goal(env: Env, id: u32) -> Result<Goal, Error> {
        Self::load(&env, id)
    }

    pub fn funded_by(env: Env, id: u32, funder: Address) -> i128 {
        env.storage()
            .persistent()
            .get::<_, Map<Address, i128>>(&DataKey::Funders(id))
            .map(|f| f.get(funder).unwrap_or(0))
            .unwrap_or(0)
    }

    /* ---------------------------------------------------------- internals */

    fn load(env: &Env, id: u32) -> Result<Goal, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Goal(id))
            .ok_or(Error::GoalNotFound)
    }

    /// Soroban archives untouched storage. A goal runs for weeks, so every
    /// write extends its life. Forgetting this is the classic way to lose a
    /// contract's state mid-flight.
    fn bump(env: &Env, id: u32) {
        const DAY: u32 = 17_280; // ledgers, ~5s each
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Goal(id), 30 * DAY, 90 * DAY);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Funders(id), 30 * DAY, 90 * DAY);
        env.storage().instance().extend_ttl(30 * DAY, 90 * DAY);
    }
}

#[cfg(test)]
mod test;
