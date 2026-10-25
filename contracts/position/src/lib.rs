#![no_std]
//! One position: one owner, one market, one product, and the borrower of
//! record in the Blend pool.
//!
//! Every position is its own contract instance, deployed from this wasm with a
//! salt made of the three things that identify it. That costs a deploy per
//! position, and it buys the thing that matters: a Blend pool sees as many
//! borrowers as there are positions, so one user's health is nobody else's
//! problem. Were the protocol a single borrower holding everyone's collateral,
//! a liquidation would be everyone's at once and bad debt would socialise.
//!
//! The contract holds no product logic. It cannot decide to borrow, it cannot
//! decide what healthy means, and it cannot be called by its own owner. The
//! core is the only caller, so the rules live in one place and this is the hand
//! that carries them out.
//!
//! What it does own is the record: how much was supplied, how much is owed, and
//! which agent last touched it. Blend is the truth for the first two and is
//! asked for them rather than trusted to match; the agent log is the only state
//! here that exists nowhere else.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env,
    Symbol, Vec,
};

mod blend {
    soroban_sdk::contractimport!(file = "../../vendor/blend_pool.wasm");
}

/// Blend's own request codes, read off blend-contracts-v2/pool/src/pool/actions.rs.
const SUPPLY_COLLATERAL: u32 = 2;
const WITHDRAW_COLLATERAL: u32 = 3;
const BORROW: u32 = 4;
const REPAY: u32 = 5;

/// Blend v2 keeps b_rate and d_rate at twelve decimals.
const RATE_SCALAR: i128 = 1_000_000_000_000;

const DAY: u32 = 17_280;
const TTL: u32 = 90 * DAY;
const BUMP: u32 = 30 * DAY;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotCore = 1,
    BadAmount = 2,
}

/// Earn puts the borrowed USDC in the Agama vault and compounds the yield back
/// into the stock. Amplify spends it on more of the same stock at once. The
/// difference is what happens to the dollars, not how the debt is carried.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Product {
    Earn,
    Amplify,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Touch {
    pub agent: Address,
    pub action: Symbol,
    pub at: u64,
}

#[derive(Clone)]
#[contracttype]
enum Key {
    Core,
    Owner,
    Stock,
    Usdc,
    Pool,
    /// Where the reserve sits in the pool's list. Blend keys a user's positions
    /// by index, not by asset, so the index is part of knowing the position.
    StockIndex,
    UsdcIndex,
    Product,
    /// The LTV this position is held at, in basis points.
    Target,
    Agent,
}

#[contractevent(topics = ["touch"])]
pub struct Touched {
    #[topic]
    pub agent: Address,
    pub action: Symbol,
    pub at: u64,
}

#[contract]
pub struct Position;

#[contractimpl]
impl Position {
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        e: Env,
        core: Address,
        owner: Address,
        stock: Address,
        usdc: Address,
        pool: Address,
        stock_index: u32,
        usdc_index: u32,
        product: Product,
        target_bps: u32,
    ) {
        let s = e.storage().instance();
        s.set(&Key::Core, &core);
        s.set(&Key::Owner, &owner);
        s.set(&Key::Stock, &stock);
        s.set(&Key::Usdc, &usdc);
        s.set(&Key::Pool, &pool);
        s.set(&Key::StockIndex, &stock_index);
        s.set(&Key::UsdcIndex, &usdc_index);
        s.set(&Key::Product, &product);
        s.set(&Key::Target, &target_bps);
        s.extend_ttl(BUMP, TTL);
    }

    fn core_addr(e: &Env) -> Address {
        e.storage().instance().get(&Key::Core).unwrap()
    }

    /// Everything that moves money is core only. Not even the owner: a position
    /// that could be drained by its owner directly would leave Blend holding a
    /// loan against collateral the core still believes is there.
    fn guard(e: &Env) {
        Self::core_addr(e).require_auth();
        e.storage().instance().extend_ttl(BUMP, TTL);
    }

    fn pool(e: &Env) -> blend::Client<'static> {
        blend::Client::new(e, &e.storage().instance().get(&Key::Pool).unwrap())
    }

    fn request(e: &Env, asset: &Address, amount: i128, kind: u32) -> Vec<blend::Request> {
        Vec::from_array(
            e,
            [blend::Request { address: asset.clone(), amount, request_type: kind }],
        )
    }

    // ---- the four things this says to Blend ----

    /// Put stock already held here up as collateral.
    pub fn supply(e: Env, amount: i128) -> Result<(), Error> {
        Self::guard(&e);
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        let stock: Address = e.storage().instance().get(&Key::Stock).unwrap();
        let me = e.current_contract_address();
        Self::pool(&e).submit(&me, &me, &me, &Self::request(&e, &stock, amount, SUPPLY_COLLATERAL));
        Ok(())
    }

    /// Borrow USDC and send it where the core says. The core is what decides
    /// the amount is within the target; this only carries it out.
    pub fn borrow(e: Env, amount: i128, to: Address) -> Result<(), Error> {
        Self::guard(&e);
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        let usdc: Address = e.storage().instance().get(&Key::Usdc).unwrap();
        let me = e.current_contract_address();
        Self::pool(&e).submit(&me, &me, &me, &Self::request(&e, &usdc, amount, BORROW));
        if to != me {
            token::Client::new(&e, &usdc).transfer(&me, &to, &amount);
        }
        Ok(())
    }

    /// Repay USDC already held here. Blend takes a repayment larger than the
    /// debt and returns the rest, so the core may pass more than it owes.
    pub fn repay(e: Env, amount: i128) -> Result<(), Error> {
        Self::guard(&e);
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        let usdc: Address = e.storage().instance().get(&Key::Usdc).unwrap();
        let me = e.current_contract_address();
        Self::pool(&e).submit(&me, &me, &me, &Self::request(&e, &usdc, amount, REPAY));
        Ok(())
    }

    /// Take collateral back out and send it on.
    pub fn unsupply(e: Env, amount: i128, to: Address) -> Result<(), Error> {
        Self::guard(&e);
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        let stock: Address = e.storage().instance().get(&Key::Stock).unwrap();
        let me = e.current_contract_address();
        Self::pool(&e).submit(&me, &me, &me, &Self::request(&e, &stock, amount, WITHDRAW_COLLATERAL));
        if to != me {
            token::Client::new(&e, &stock).transfer(&me, &to, &amount);
        }
        Ok(())
    }

    // ---- moving what is loose ----

    /// Send a token this position is holding outside the pool. Used to pass the
    /// borrowed dollars to the vault and to hand the stock back on close.
    pub fn send(e: Env, token_id: Address, to: Address, amount: i128) -> Result<(), Error> {
        Self::guard(&e);
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        token::Client::new(&e, &token_id).transfer(&e.current_contract_address(), &to, &amount);
        Ok(())
    }

    /// Let another contract pull from here: the Agama vault takes its deposit
    /// rather than being sent one.
    pub fn approve(e: Env, token_id: Address, spender: Address, amount: i128, expires: u32) {
        Self::guard(&e);
        token::Client::new(&e, &token_id).approve(
            &e.current_contract_address(),
            &spender,
            &amount,
            &expires,
        );
    }

    // ---- the record ----

    pub fn set_target(e: Env, target_bps: u32) {
        Self::guard(&e);
        e.storage().instance().set(&Key::Target, &target_bps);
    }

    /// Who last acted on this position and what they did. Written on every
    /// agent pass so a card can say the automation is running and when it last
    /// ran, rather than asserting it.
    pub fn touch(e: Env, agent: Address, action: Symbol) {
        Self::guard(&e);
        let at = e.ledger().timestamp();
        e.storage()
            .instance()
            .set(&Key::Agent, &Touch { agent: agent.clone(), action: action.clone(), at });
        Touched { agent, action, at }.publish(&e);
    }

    // ---- what Blend says, converted ----

    /// The stock put up, in the token's own units. Blend holds b_tokens; the
    /// reserve's b_rate is what turns them back into shares.
    pub fn collateral(e: Env) -> i128 {
        let pool = Self::pool(&e);
        let idx: u32 = e.storage().instance().get(&Key::StockIndex).unwrap();
        let stock: Address = e.storage().instance().get(&Key::Stock).unwrap();
        let b = pool
            .get_positions(&e.current_contract_address())
            .collateral
            .get(idx)
            .unwrap_or(0);
        b * pool.get_reserve(&stock).data.b_rate / RATE_SCALAR
    }

    /// The USDC owed, interest included. d_tokens times d_rate, rounded up:
    /// a debt rounded down is a debt someone else pays.
    pub fn debt(e: Env) -> i128 {
        let pool = Self::pool(&e);
        let idx: u32 = e.storage().instance().get(&Key::UsdcIndex).unwrap();
        let usdc: Address = e.storage().instance().get(&Key::Usdc).unwrap();
        let d = pool
            .get_positions(&e.current_contract_address())
            .liabilities
            .get(idx)
            .unwrap_or(0);
        if d == 0 {
            return 0;
        }
        let rate = pool.get_reserve(&usdc).data.d_rate;
        (d * rate + RATE_SCALAR - 1) / RATE_SCALAR
    }

    pub fn owner(e: Env) -> Address {
        e.storage().instance().get(&Key::Owner).unwrap()
    }
    pub fn stock(e: Env) -> Address {
        e.storage().instance().get(&Key::Stock).unwrap()
    }
    pub fn product(e: Env) -> Product {
        e.storage().instance().get(&Key::Product).unwrap()
    }
    pub fn target(e: Env) -> u32 {
        e.storage().instance().get(&Key::Target).unwrap()
    }
    pub fn last_touch(e: Env) -> Option<Touch> {
        e.storage().instance().get(&Key::Agent)
    }
    pub fn core(e: Env) -> Address {
        e.storage().instance().get(&Key::Core).unwrap()
    }
}

mod test;
