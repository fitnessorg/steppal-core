use soroban_sdk::{contractevent, Address, Env};

#[contractevent(topics = ["goal_created"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GoalCreatedEvent {
    #[topic]
    pub id: u32,
    pub target_steps: u32,
}

#[contractevent(topics = ["funded"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundedEvent {
    #[topic]
    pub id: u32,
    #[topic]
    pub funder: Address,
    pub amount: i128,
}

#[contractevent(topics = ["attested"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttestedEvent {
    #[topic]
    pub id: u32,
    pub steps: u32,
}

#[contractevent(topics = ["disputed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisputedEvent {
    #[topic]
    pub id: u32,
    pub challenger: Address,
}

#[contractevent(topics = ["claimed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimedEvent {
    #[topic]
    pub id: u32,
    pub payout: i128,
}

#[contractevent(topics = ["refunded"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RefundedEvent {
    #[topic]
    pub id: u32,
    #[topic]
    pub funder: Address,
    pub owed: i128,
}

pub fn goal_created(env: &Env, id: u32, target_steps: u32) {
    GoalCreatedEvent { id, target_steps }.publish(env);
}

pub fn funded(env: &Env, id: u32, funder: Address, amount: i128) {
    FundedEvent { id, funder, amount }.publish(env);
}

pub fn attested(env: &Env, id: u32, steps: u32) {
    AttestedEvent { id, steps }.publish(env);
}

pub fn disputed(env: &Env, id: u32, challenger: Address) {
    DisputedEvent { id, challenger }.publish(env);
}

pub fn claimed(env: &Env, id: u32, payout: i128) {
    ClaimedEvent { id, payout }.publish(env);
}

pub fn refunded(env: &Env, id: u32, funder: Address, owed: i128) {
    RefundedEvent { id, funder, owed }.publish(env);
}
