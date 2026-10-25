#![no_std]
//! The protocol: markets, the two products, and the three agents.
//!
//! Everything a user calls is here, and everything that decides is here. The
//! positions carry out; the oracle says what things are worth; Blend holds the
//! loan; the Agama vault holds the dollars. This contract is the only one that
//! knows what healthy means.
//!
//! # The buffer, and why it exists
//!
//! The Agama vault does not pay out on demand. A withdrawal is a request in a
//! FIFO queue and it settles when the queue reaches it, which is the honest
//! behaviour of a credit book: the money is lent out, it is not sitting there.
//!
//! That collides with the one promise this product makes. When the stock falls,
//! the agents repay out of the vault position rather than selling the stock, and
//! "rather than selling the stock" is worth nothing if the repayment waits three
//! days for a queue.
//!
//! So the core keeps a USDC buffer. A rebalance down repays out of the buffer
//! immediately and files a withdrawal request against the vault to refill it;
//! the queue settles in its own time, behind the user rather than in front of
//! them. Liquidation does the same thing first, for the same reason. The buffer
//! is the part of the design that is not free, and `buffer()` is public so
//! anyone can see how much of it is left.
//!
//! # Buying stock on a testnet
//!
//! Amplify borrows dollars and buys more of the same stock. There is no venue
//! to buy a stand-in token on, so the core mints it at the oracle price and
//! keeps the dollars. That is a stand-in for a swap, it is only honest because
//! the token is a stand-in too, and it is the one place in this protocol where
//! a number comes from us rather than from a signature. When the real tokens
//! land, this is the function that becomes a route and nothing else moves.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, symbol_short, token,
    Address, BytesN, Env, IntoVal, String, Symbol, Val, Vec,
};

/// The position's own spec, read from the wasm the workspace just built.
///
/// This makes the build order real: `position` has to be compiled before
/// `core` or this file does not exist. `stellar contract build` does the
/// workspace in dependency order and gets it right; a bare `cargo build -p
/// core` on a fresh clone does not, and says only that a file is missing.
mod position {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/position.wasm");
}

const DAY: u32 = 17_280;
const TTL: u32 = 90 * DAY;
const BUMP: u32 = 30 * DAY;

const BPS: i128 = 10_000;
/// Both the stocks and USDC are seven decimals here, which is Stellar's own.
const UNIT: i128 = 10_000_000;
/// How long an address waits between unsigned drips. The same hour each token
/// asks for, so the two faucets cannot be alternated to halve it.
const FAUCET_COOLDOWN: u64 = 3600;


#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotAdmin = 1,
    UnknownMarket = 2,
    MarketExists = 3,
    MarketDisabled = 4,
    BadAmount = 5,
    /// The target is above what the market allows, or zero.
    BadTarget = 6,
    NoPosition = 7,
    PositionExists = 8,
    /// No price, or one older than the market will accept.
    StalePrice = 9,
    /// The buffer cannot cover what this call has to repay now.
    BufferEmpty = 10,
    /// Health is above the threshold: there is nothing to liquidate.
    Healthy = 11,
    Paused = 12,
    /// This address has already been served inside the cooldown.
    FaucetCooldown = 13,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Product {
    Earn,
    Amplify,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Market {
    /// The stand-in token, and the Blend reserve it is.
    pub token: Address,
    pub reserve_index: u32,
    /// What a position may borrow against it, and where it becomes
    /// liquidatable. Both in basis points, both tightened while the session is
    /// shut.
    pub ltv: u32,
    pub threshold: u32,
    pub off_hours_buffer: u32,
    /// True while the share's own session is closed. The token trades around
    /// the clock; the company behind it does not.
    pub off_hours: bool,
    pub enabled: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Health {
    /// The stock put up, priced by the oracle, in USDC units.
    pub collateral: i128,
    pub debt: i128,
    /// debt over collateral, in basis points. Zero when there is no debt.
    pub ltv: u32,
    /// What this market allows right now, session included.
    pub max_ltv: u32,
    pub threshold: u32,
}

#[derive(Clone)]
#[contracttype]
enum Key {
    Admin,
    Usdc,
    Pool,
    UsdcIndex,
    Oracle,
    Vault,
    PositionWasm,
    MaxPriceAge,
    Paused,
    /// Dollars held here, to repay with before the vault queue can answer.
    Buffer,
    Markets,
    Market(Address),
    /// (owner, stock, product) -> the position contract
    Pos(Address, Address, Product),
    /// Every position, so an agent can walk them without an indexer.
    All,
    /// When this address last took the unsigned drip.
    Drip(Address),
}

#[contractevent(topics = ["opened"])]
pub struct Opened {
    #[topic]
    pub owner: Address,
    #[topic]
    pub market: Address,
    pub position: Address,
    pub product: Product,
    pub collateral: i128,
    pub borrowed: i128,
    pub target_bps: u32,
}

#[contractevent(topics = ["closed"])]
pub struct Closed {
    #[topic]
    pub owner: Address,
    #[topic]
    pub market: Address,
    pub position: Address,
    pub returned: i128,
}

#[contractevent(topics = ["agent"])]
pub struct AgentRan {
    #[topic]
    pub agent: Address,
    #[topic]
    pub position: Address,
    pub action: Symbol,
    /// Signed: what the debt moved by. A rebalance up is positive, a rebalance
    /// down negative, a compound zero.
    pub delta: i128,
}

/// The slice of the oracle this protocol uses: SEP-40's `lastprice`.
mod oracle {
    use soroban_sdk::{contractclient, contracttype, Address, Env, Symbol};
    #[contracttype]
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub enum Asset {
        Stellar(Address),
        Other(Symbol),
    }
    #[contracttype]
    #[derive(Clone, Debug, Eq, PartialEq)]
    pub struct PriceData {
        pub price: i128,
        pub timestamp: u64,
    }
    #[allow(dead_code)]
    #[contractclient(name = "OracleClient")]
    pub trait Oracle {
        fn lastprice(e: Env, asset: Asset) -> Option<PriceData>;
        fn decimals(e: Env) -> u32;
    }
}

use oracle::{Asset, OracleClient};
use position::Client as PositionClient;

#[contract]
pub struct Core;

#[contractimpl]
impl Core {
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        e: Env,
        admin: Address,
        usdc: Address,
        usdc_reserve_index: u32,
        pool: Address,
        oracle: Address,
        vault: Address,
        position_wasm: BytesN<32>,
        max_price_age: u64,
    ) {
        let s = e.storage().instance();
        s.set(&Key::Admin, &admin);
        s.set(&Key::Usdc, &usdc);
        s.set(&Key::UsdcIndex, &usdc_reserve_index);
        s.set(&Key::Pool, &pool);
        s.set(&Key::Oracle, &oracle);
        s.set(&Key::Vault, &vault);
        s.set(&Key::PositionWasm, &position_wasm);
        s.set(&Key::MaxPriceAge, &max_price_age);
        s.set(&Key::Paused, &false);
        s.set(&Key::Buffer, &0i128);
        s.set(&Key::Markets, &Vec::<Address>::new(&e));
        s.set(&Key::All, &Vec::<Address>::new(&e));
        s.extend_ttl(BUMP, TTL);
    }

    // ---- admin ----

    fn admin(e: &Env) -> Address {
        e.storage().instance().get(&Key::Admin).unwrap()
    }

    fn only_admin(e: &Env) {
        Self::admin(e).require_auth();
        e.storage().instance().extend_ttl(BUMP, TTL);
    }

    pub fn add_market(
        e: Env,
        token: Address,
        reserve_index: u32,
        ltv: u32,
        threshold: u32,
        off_hours_buffer: u32,
    ) -> Result<(), Error> {
        Self::only_admin(&e);
        if e.storage().instance().has(&Key::Market(token.clone())) {
            return Err(Error::MarketExists);
        }
        if ltv == 0 || ltv >= threshold || threshold as i128 >= BPS {
            return Err(Error::BadTarget);
        }
        let m = Market {
            token: token.clone(),
            reserve_index,
            ltv,
            threshold,
            off_hours_buffer,
            off_hours: false,
            enabled: true,
        };
        e.storage().instance().set(&Key::Market(token.clone()), &m);
        let mut all: Vec<Address> = e.storage().instance().get(&Key::Markets).unwrap();
        all.push_back(token);
        e.storage().instance().set(&Key::Markets, &all);
        Ok(())
    }

    /// The session switch. It is admin only and it is not a price: it says
    /// whether the company behind the token is trading, which no signature in
    /// a price report carries.
    /// Point the protocol at a different oracle.
    ///
    /// The live deployment was built without this and the cost showed up
    /// immediately: the oracle needed one admin function it did not have, and
    /// because the core's oracle was fixed at construction the only way to
    /// replace it was to replace the core, which owns the stock tokens, whose
    /// admin cannot be taken back. A setter here would have made that a single
    /// transaction.
    pub fn set_oracle(e: Env, oracle: Address) {
        Self::admin(&e).require_auth();
        e.storage().instance().set(&Key::Oracle, &oracle);
        e.storage().instance().extend_ttl(BUMP, TTL);
    }

    /// Replace the code behind this address, keeping the storage, the markets
    /// and the positions.
    pub fn upgrade(e: Env, new_wasm_hash: BytesN<32>) {
        Self::admin(&e).require_auth();
        e.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    pub fn set_session(e: Env, token: Address, off_hours: bool) -> Result<(), Error> {
        Self::only_admin(&e);
        let mut m = Self::market(&e, &token)?;
        m.off_hours = off_hours;
        e.storage().instance().set(&Key::Market(token), &m);
        Ok(())
    }

    pub fn set_enabled(e: Env, token: Address, enabled: bool) -> Result<(), Error> {
        Self::only_admin(&e);
        let mut m = Self::market(&e, &token)?;
        m.enabled = enabled;
        e.storage().instance().set(&Key::Market(token), &m);
        Ok(())
    }

    pub fn set_paused(e: Env, paused: bool) {
        Self::only_admin(&e);
        e.storage().instance().set(&Key::Paused, &paused);
    }

    /// Put dollars in the buffer. Anyone may: a bigger buffer is better for
    /// everyone and worse for nobody, and the depositor gets nothing for it,
    /// so there is nothing to game.
    pub fn fund_buffer(e: Env, from: Address, amount: i128) -> Result<(), Error> {
        from.require_auth();
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        let usdc: Address = e.storage().instance().get(&Key::Usdc).unwrap();
        token::Client::new(&e, &usdc).transfer(&from, &e.current_contract_address(), &amount);
        Self::buffer_add(&e, amount);
        Ok(())
    }

    // ---- reading the world ----

    fn market(e: &Env, token: &Address) -> Result<Market, Error> {
        e.storage()
            .instance()
            .get(&Key::Market(token.clone()))
            .ok_or(Error::UnknownMarket)
    }

    fn live_market(e: &Env, token: &Address) -> Result<Market, Error> {
        if e.storage().instance().get::<_, bool>(&Key::Paused).unwrap() {
            return Err(Error::Paused);
        }
        let m = Self::market(e, token)?;
        if !m.enabled {
            return Err(Error::MarketDisabled);
        }
        Ok(m)
    }

    /// What the market allows right now. While the session is shut both numbers
    /// tighten by the same buffer, so the room to act narrows from both sides at
    /// once rather than the position being caught between them.
    fn terms(m: &Market) -> (u32, u32) {
        if m.off_hours {
            (
                m.ltv.saturating_sub(m.off_hours_buffer),
                m.threshold.saturating_sub(m.off_hours_buffer),
            )
        } else {
            (m.ltv, m.threshold)
        }
    }

    /// One unit of the stock in USDC units, refusing a price that is too old.
    /// Staleness stops a borrow; it never stops a repayment, which is why every
    /// caller that only reduces debt reads the stored price without this.
    fn price(e: &Env, token: &Address) -> Result<i128, Error> {
        let oracle: Address = e.storage().instance().get(&Key::Oracle).unwrap();
        let max_age: u64 = e.storage().instance().get(&Key::MaxPriceAge).unwrap();
        let p = OracleClient::new(e, &oracle)
            .lastprice(&Asset::Stellar(token.clone()))
            .ok_or(Error::StalePrice)?;
        let now = e.ledger().timestamp();
        if now > p.timestamp && now - p.timestamp > max_age {
            return Err(Error::StalePrice);
        }
        Ok(p.price)
    }

    fn usdc(e: &Env) -> Address {
        e.storage().instance().get(&Key::Usdc).unwrap()
    }

    fn buffer_add(e: &Env, amount: i128) {
        let b: i128 = e.storage().instance().get(&Key::Buffer).unwrap();
        e.storage().instance().set(&Key::Buffer, &(b + amount));
    }

    fn buffer_take(e: &Env, amount: i128) -> Result<(), Error> {
        let b: i128 = e.storage().instance().get(&Key::Buffer).unwrap();
        if b < amount {
            return Err(Error::BufferEmpty);
        }
        e.storage().instance().set(&Key::Buffer, &(b - amount));
        Ok(())
    }

    pub fn buffer(e: Env) -> i128 {
        e.storage().instance().get(&Key::Buffer).unwrap()
    }

    pub fn markets(e: Env) -> Vec<Address> {
        e.storage().instance().get(&Key::Markets).unwrap()
    }

    pub fn market_of(e: Env, token: Address) -> Result<Market, Error> {
        Self::market(&e, &token)
    }

    pub fn positions(e: Env) -> Vec<Address> {
        e.storage().instance().get(&Key::All).unwrap()
    }

    pub fn position_of(
        e: Env,
        owner: Address,
        token: Address,
        product: Product,
    ) -> Option<Address> {
        e.storage().instance().get(&Key::Pos(owner, token, product))
    }

    /// Everything a reader needs to judge a position, priced now.
    pub fn health(e: Env, position: Address) -> Result<Health, Error> {
        let p = PositionClient::new(&e, &position);
        let token = p.stock();
        let m = Self::market(&e, &token)?;
        let (max_ltv, threshold) = Self::terms(&m);
        let price = Self::price(&e, &token)?;
        let collateral = p.collateral() * price / UNIT;
        let debt = p.debt();
        let ltv = if collateral <= 0 { 0 } else { (debt * BPS / collateral) as u32 };
        Ok(Health { collateral, debt, ltv, max_ltv, threshold })
    }

    /// Every market's faucet and the dollar's, in one call.
    ///
    /// Eleven tokens is eleven wallet approvals if the screen asks for them
    /// one at a time, and a testnet whose first step is eleven signatures is
    /// a testnet most people leave at the first one. The user signs once and
    /// their signature covers the whole tree, which is what satisfies each
    /// token's own `to.require_auth()` on the way down.
    ///
    /// A token on cooldown is skipped rather than fatal. The alternative is a
    /// click that reverts the other ten because one of them was claimed four
    /// minutes ago, which is the sort of thing that reads as "the faucet is
    /// broken".
    pub fn faucet(e: Env, to: Address) -> Result<u32, Error> {
        to.require_auth();
        let mut got = 0u32;
        // Addresses, not Markets: Key::Markets holds the token list. Reading
        // it as the wrong type compiles perfectly well and fails at runtime.
        let markets: Vec<Address> = e.storage().instance().get(&Key::Markets).unwrap();
        for token in markets.iter() {
            if Self::drip(&e, &token, &to) {
                got += 1;
            }
        }
        if Self::drip(&e, &Self::usdc(&e), &to) {
            got += 1;
        }
        Ok(got)
    }

    /// The same assets, with nobody's signature on the request.
    ///
    /// `faucet` above leans on the caller's signature covering the whole tree:
    /// eleven token faucets, each checking it on the way down. A wallet that
    /// can sign for any contract gives that in one approval. A smart account
    /// cannot: it authorizes per contract, by a rule its owner approves one at
    /// a time, so the same click would be twelve passkey confirmations before
    /// anything arrives. That is not a faucet.
    ///
    /// So this asks nobody to authorize anything. The core is the stocks'
    /// admin, so it mints them outright. The dollar is not ours to mint, so it
    /// comes out of what this contract holds above the buffer, and the dollar's
    /// own faucet refills that whenever its own cooldown has passed. The
    /// buffer is never touched: it is what answers a falling position, and a
    /// visitor's test dollars are not worth spending it on.
    ///
    /// Open to anyone, for any address, like every faucet here. It mints a
    /// fixed quantity on a cooldown, so there is nothing to game: the worst a
    /// stranger can do with it is give somebody else their hour's share.
    pub fn faucet_for(e: Env, to: Address) -> Result<u32, Error> {
        let now = e.ledger().timestamp();
        let key = Key::Drip(to.clone());
        if let Some(last) = e.storage().persistent().get::<_, u64>(&key) {
            if now < last + FAUCET_COOLDOWN {
                return Err(Error::FaucetCooldown);
            }
        }
        e.storage().persistent().set(&key, &now);
        e.storage().persistent().extend_ttl(&key, BUMP, TTL);

        let me = e.current_contract_address();
        let mut got = 0u32;
        let markets: Vec<Address> = e.storage().instance().get(&Key::Markets).unwrap();
        for token in markets.iter() {
            let amount = Self::drip_size(&e, &token);
            if amount > 0 {
                e.invoke_contract::<()>(
                    &token,
                    &Symbol::new(&e, "mint"),
                    Vec::from_array(&e, [to.into_val(&e), amount.into_val(&e)]),
                );
                got += 1;
            }
        }

        let usdc = Self::usdc(&e);
        // Refill first, so the hour's claim is paid out of what the dollar's
        // own faucet just gave rather than out of the last visitor's share.
        Self::drip(&e, &usdc, &me);
        let amount = Self::drip_size(&e, &usdc);
        let held = token::Client::new(&e, &usdc).balance(&me);
        let buffer: i128 = e.storage().instance().get(&Key::Buffer).unwrap();
        if amount > 0 && held - buffer >= amount {
            token::Client::new(&e, &usdc).transfer(&me, &to, &amount);
            got += 1;
        }
        e.storage().instance().extend_ttl(BUMP, TTL);
        Ok(got)
    }

    /// What one token's faucet hands out, or zero when it has none.
    fn drip_size(e: &Env, token: &Address) -> i128 {
        e.try_invoke_contract::<i128, soroban_sdk::Error>(
            token,
            &Symbol::new(e, "drip"),
            Vec::new(e),
        )
        .map(|r| r.unwrap_or(0))
        .unwrap_or(0)
    }

    /// How long `who` has to wait before the unsigned drip gives again.
    pub fn faucet_for_in(e: Env, who: Address) -> u64 {
        match e.storage().persistent().get::<_, u64>(&Key::Drip(who)) {
            Some(last) => (last + FAUCET_COOLDOWN).saturating_sub(e.ledger().timestamp()),
            None => 0,
        }
    }

    /// One token's faucet, and whether it gave anything.
    fn drip(e: &Env, token: &Address, to: &Address) -> bool {
        e.try_invoke_contract::<i128, soroban_sdk::Error>(
            token,
            &Symbol::new(e, "faucet"),
            Vec::from_array(e, [to.into_val(e)]),
        )
        .is_ok()
    }

    /// How long `who` has to wait on each market, and on the dollar, before
    /// the faucet gives again. Zero means ready.
    pub fn faucet_in(e: Env, who: Address) -> Vec<u64> {
        let markets: Vec<Address> = e.storage().instance().get(&Key::Markets).unwrap();
        let mut out = Vec::new(&e);
        for token in markets.iter() {
            out.push_back(Self::wait_for(&e, &token, &who));
        }
        out.push_back(Self::wait_for(&e, &Self::usdc(&e), &who));
        out
    }

    fn wait_for(e: &Env, token: &Address, who: &Address) -> u64 {
        e.try_invoke_contract::<u64, soroban_sdk::Error>(
            token,
            &Symbol::new(e, "faucet_in"),
            Vec::from_array(e, [who.into_val(e)]),
        )
        .map(|r| r.unwrap_or(0))
        .unwrap_or(0)
    }

    // ---- positions ----

    fn get_or_deploy(
        e: &Env,
        owner: &Address,
        m: &Market,
        product: Product,
        target_bps: u32,
    ) -> Address {
        let key = Key::Pos(owner.clone(), m.token.clone(), product);
        if let Some(existing) = e.storage().instance().get::<_, Address>(&key) {
            return existing;
        }

        // The salt is the three things that identify a position, so the address
        // is derivable off chain and a second deploy of the same position is
        // impossible rather than merely refused.
        let mut salt_src = soroban_sdk::Bytes::new(e);
        salt_src.append(&owner.clone().to_xdr(e));
        salt_src.append(&m.token.clone().to_xdr(e));
        salt_src.push_back(match product {
            Product::Earn => 0,
            Product::Amplify => 1,
        });
        let salt: BytesN<32> = e.crypto().sha256(&salt_src).into();

        let wasm: BytesN<32> = e.storage().instance().get(&Key::PositionWasm).unwrap();
        let mut args: Vec<Val> = Vec::new(e);
        args.push_back(e.current_contract_address().into_val(e));
        args.push_back(owner.into_val(e));
        args.push_back(m.token.into_val(e));
        args.push_back(Self::usdc(e).into_val(e));
        args.push_back(
            e.storage()
                .instance()
                .get::<_, Address>(&Key::Pool)
                .unwrap()
                .into_val(e),
        );
        args.push_back(m.reserve_index.into_val(e));
        args.push_back(
            e.storage()
                .instance()
                .get::<_, u32>(&Key::UsdcIndex)
                .unwrap()
                .into_val(e),
        );
        args.push_back(
            match product {
                Product::Earn => position::Product::Earn,
                Product::Amplify => position::Product::Amplify,
            }
            .into_val(e),
        );
        args.push_back(target_bps.into_val(e));

        let addr = e
            .deployer()
            .with_current_contract(salt)
            .deploy_v2(wasm, args);

        e.storage().instance().set(&key, &addr);
        let mut all: Vec<Address> = e.storage().instance().get(&Key::All).unwrap();
        all.push_back(addr.clone());
        e.storage().instance().set(&Key::All, &all);
        addr
    }

    /// How much a position may owe at a given LTV, priced now.
    fn debt_at(collateral_units: i128, price: i128, bps: u32) -> i128 {
        collateral_units * price / UNIT * bps as i128 / BPS
    }

    // ---- Earn ----

    /// Deposit the stock, borrow to the level you pick, and the dollars go to
    /// the vault. One call: a deposit that leaves the borrowing to a second
    /// transaction is a position that spends a block unlevered and a user who
    /// can walk away halfway.
    pub fn earn_deposit(
        e: Env,
        owner: Address,
        token: Address,
        amount: i128,
        target_bps: u32,
    ) -> Result<Address, Error> {
        owner.require_auth();
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        let m = Self::live_market(&e, &token)?;
        let (max_ltv, _) = Self::terms(&m);
        if target_bps == 0 || target_bps > max_ltv {
            return Err(Error::BadTarget);
        }
        let price = Self::price(&e, &token)?;

        let pos = Self::get_or_deploy(&e, &owner, &m, Product::Earn, target_bps);
        let p = PositionClient::new(&e, &pos);

        token::Client::new(&e, &token).transfer(&owner, &pos, &amount);
        p.supply(&amount);
        p.set_target(&target_bps);

        let want = Self::debt_at(p.collateral(), price, target_bps);
        let owed = p.debt();
        let borrow = want - owed;
        if borrow > 0 {
            Self::borrow_into_vault(&e, &p, borrow);
        }

        e.storage().instance().extend_ttl(BUMP, TTL);
        Opened {
            owner,
            market: token,
            position: pos.clone(),
            product: Product::Earn,
            collateral: amount,
            borrowed: borrow.max(0),
            target_bps,
        }
        .publish(&e);
        Ok(pos)
    }

    /// Borrow and put the dollars in the vault, in one step, so a position is
    /// never holding idle cash between two calls.
    fn borrow_into_vault(e: &Env, p: &PositionClient, amount: i128) {
        let vault: Address = e.storage().instance().get(&Key::Vault).unwrap();
        p.borrow(&amount, &p.address);
        // The position calls the vault, not us: the vault asks the depositor
        // to authorise, and the position can only say so from inside its own
        // frame.
        p.vault_deposit(&vault, &amount);
    }

    pub fn earn_set_target(
        e: Env,
        owner: Address,
        token: Address,
        target_bps: u32,
    ) -> Result<(), Error> {
        owner.require_auth();
        let m = Self::live_market(&e, &token)?;
        let (max_ltv, _) = Self::terms(&m);
        if target_bps == 0 || target_bps > max_ltv {
            return Err(Error::BadTarget);
        }
        let pos: Address = e
            .storage()
            .instance()
            .get(&Key::Pos(owner, token, Product::Earn))
            .ok_or(Error::NoPosition)?;
        PositionClient::new(&e, &pos).set_target(&target_bps);
        Ok(())
    }

    // ---- the agents, all permissionless ----

    /// Hold the position at its target. Up, it borrows the difference and the
    /// dollars go to the vault. Down, it repays out of the buffer and files a
    /// withdrawal against the vault to refill it, so the repayment happens now
    /// and the queue happens behind the user.
    pub fn rebalance(e: Env, agent: Address, position: Address) -> Result<i128, Error> {
        agent.require_auth();
        let p = PositionClient::new(&e, &position);
        let token = p.stock();
        let m = Self::live_market(&e, &token)?;
        let price = Self::price(&e, &token)?;
        let (max_ltv, _) = Self::terms(&m);

        let target = p.target().min(max_ltv);
        let owed = p.debt();
        let want = Self::debt_at(p.collateral(), price, target);

        // The position's own Product, which the wasm import gives its own
        // type: same shape, different name, so it is compared on its side.
        let amplify = p.product() == position::Product::Amplify;

        // How much the debt has to move, and the two products do not compute
        // it the same way.
        //
        // An Earn borrows into the vault, so the collateral does not move and
        // the answer is simply the gap to the target.
        //
        // An Amplify spends what it borrows on more of the same stock, which
        // lifts the denominator too, so closing the gap by the gap leaves the
        // position short every time. Solving D' / (V + D' - D) = t for D'
        // gives D' - D = (tV - D) / (1 - t), which is the same number divided
        // by what is left of the ratio. At a two-thirds target that is three
        // times larger, and getting it wrong does not look like a bug: the
        // LTV simply never quite arrives and the agent runs again next pass.
        let delta = if amplify {
            (want - owed) * BPS / (BPS - target as i128)
        } else {
            want - owed
        };

        // Where the dollars go, as well as how many of them, depends on what
        // the position is FOR.
        //
        // An Earn is holding stock and lending its value out: a rise borrows
        // more into the vault, a fall is repaid out of the buffer so that no
        // stock has to be sold. An Amplify is holding a multiple of the stock:
        // a rise buys more of it, and a fall sells just enough to repay. Send
        // an Amplify's borrowings to the vault and the multiple quietly
        // decays while the LTV reads correct, which is the worst shape a bug
        // can take: every number on the screen agrees and the position is not
        // the one the user asked for.
        // The position's own Product, which the wasm import gives its own
        // type: same shape, different name, so it is compared on its side.
        if delta > 0 {
            if amplify {
                // Pledged before borrowed, the same order as an open, and for
                // the same reason: the pool checks health at the moment of the
                // borrow, not at the end of the transaction. Borrow first and
                // the position is momentarily holding a loan against
                // collateral that has not arrived yet, which Blend refuses
                // with InvalidHf, a long way from the line that caused it.
                let bought = Self::buy_stock_from_core(&e, &m, &p.address, delta, price);
                p.supply(&bought);
                p.borrow(&delta, &e.current_contract_address());
            } else {
                Self::borrow_into_vault(&e, &p, delta);
            }
        } else if delta < 0 {
            if amplify {
                Self::sell_to_repay(&e, &m, &p, -delta, price);
            } else {
                Self::repay_from_buffer(&e, &p, -delta)?;
            }
        }

        p.touch(&agent, &symbol_short!("rebal"));
        AgentRan { agent, position, action: symbol_short!("rebal"), delta }.publish(&e);
        Ok(delta)
    }

    /// Sell exactly enough of the stock to repay, and not a share more.
    ///
    /// An Amplify has no vault balance to draw on and no buffer claim: its
    /// dollars are all in stock, by construction. So a fall is answered the
    /// only way it can be, by unwinding part of the loop. That is not a
    /// failure of the design, it is what a multiple means: the stock bought
    /// with borrowed money is the stock that goes back when the loan shrinks.
    /// What never happens is selling the deposit itself, because the sale is
    /// sized to the debt rather than to the position.
    fn sell_to_repay(e: &Env, m: &Market, p: &PositionClient, amount: i128, price: i128) {
        // Repaid before the stock leaves, which is the mirror of pledging
        // before borrowing and refused for the same reason if done the other
        // way round: taking collateral out while the debt still stands raises
        // the LTV, and a position being rescued from a fall has no room for
        // that. The core advances the dollars and takes the stock as payment
        // once the debt is gone.
        let usdc = Self::usdc(e);
        token::Client::new(e, &usdc).transfer(&e.current_contract_address(), &p.address, &amount);
        p.repay(&amount);
        // Rounded up, so the sale covers what was advanced rather than
        // leaving a remainder the next pass has to come back for.
        let units = amount * UNIT / price + 1;
        p.unsupply(&units, &e.current_contract_address());
        let _ = m;
    }

    /// Repay now out of the buffer, and ask the vault for the money back. The
    /// position's own vault balance is what the request is filed against, so
    /// the buffer is lent to the position and returned by the queue, never
    /// spent on it.
    fn repay_from_buffer(e: &Env, p: &PositionClient, amount: i128) -> Result<(), Error> {
        Self::buffer_take(e, amount)?;
        let usdc = Self::usdc(e);
        token::Client::new(e, &usdc).transfer(&e.current_contract_address(), &p.address, &amount);
        p.repay(&amount);

        let vault: Address = e.storage().instance().get(&Key::Vault).unwrap();
        p.vault_request(&vault, &amount);
        Ok(())
    }

    /// Turn the yield above the debt into more of the stock. What grows is the
    /// share count, which is the whole product: a dollar balance that goes up
    /// is a different promise.
    pub fn compound(e: Env, agent: Address, position: Address) -> Result<i128, Error> {
        agent.require_auth();
        let p = PositionClient::new(&e, &position);
        let token = p.stock();
        let m = Self::live_market(&e, &token)?;
        let price = Self::price(&e, &token)?;

        // Whatever dollars the position is holding loose are yield that already
        // came back from the queue. Nothing else leaves cash there.
        let usdc = Self::usdc(&e);
        let cash = token::Client::new(&e, &usdc).balance(&p.address);
        if cash <= 0 {
            p.touch(&agent, &symbol_short!("compnd"));
            AgentRan { agent, position, action: symbol_short!("compnd"), delta: 0 }.publish(&e);
            return Ok(0);
        }

        // The position hands the dollars over rather than the core pulling
        // them: a pull would need an allowance, and an allowance standing
        // between a position and the core is a thing somebody has to maintain.
        p.send(&usdc, &e.current_contract_address(), &cash);
        let bought = Self::buy_stock_from_core(&e, &m, &p.address, cash, price);
        p.supply(&bought);

        p.touch(&agent, &symbol_short!("compnd"));
        AgentRan { agent, position, action: symbol_short!("compnd"), delta: 0 }.publish(&e);
        Ok(bought)
    }

    /// Close: repay everything out of the buffer, take the collateral back,
    /// hand the stock to its owner, and leave the vault request behind to
    /// refill the buffer.
    pub fn earn_close(e: Env, owner: Address, token: Address) -> Result<i128, Error> {
        owner.require_auth();
        let key = Key::Pos(owner.clone(), token.clone(), Product::Earn);
        let pos: Address = e.storage().instance().get(&key).ok_or(Error::NoPosition)?;
        let p = PositionClient::new(&e, &pos);

        let owed = p.debt();
        if owed > 0 {
            Self::repay_from_buffer(&e, &p, owed)?;
        }
        let collateral = p.collateral();
        if collateral > 0 {
            p.unsupply(&collateral, &owner);
        }

        e.storage().instance().remove(&key);
        Closed { owner, market: token, position: pos, returned: collateral }.publish(&e);
        Ok(collateral)
    }

    // ---- Amplify ----

    /// Deposit a stock, end up holding a multiple of it, in one call.
    ///
    /// `leverage_bps` is a multiple of the deposit, not an LTV: 30_000 is 3x,
    /// meaning three dollars of stock standing on one of your own. The LTV
    /// that implies is (L - 1) / L, so the market's own ceiling caps the
    /// multiple at 1 / (1 - ltv) and nothing here can exceed it.
    ///
    /// The product is a loop: borrow against the stock, buy more of the same
    /// stock, pledge that too, go round again. Each pass borrows against
    /// everything pledged so far, because the stock the last borrow bought is
    /// collateral too. Run literally it converges from below and never quite
    /// arrives: at a 70% market the shortfall after n passes is 0.7^n of the
    /// deposit, so eight passes reach 3.14x of the 3.33x on offer, and they
    /// cost sixteen calls into the pool to get there. On Soroban that is not
    /// a slow transaction, it is one that exceeds the CPU budget and reverts.
    ///
    /// So the loop is settled in one step instead of walked. The core
    /// advances the whole multiple of stock, pledges it, and then borrows
    /// against the full position and keeps the dollars as payment for what it
    /// advanced. The end state is identical to the loop's limit, exactly
    /// rather than approximately, in two calls to the pool instead of
    /// sixteen. Nothing is borrowed uncollateralised at any point: the stock
    /// is pledged before the loan it secures exists, and the transaction
    /// either reaches that state or reverts to none of it.
    pub fn amplify_open(
        e: Env,
        owner: Address,
        token: Address,
        amount: i128,
        leverage_bps: u32,
    ) -> Result<Address, Error> {
        owner.require_auth();
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        if leverage_bps <= BPS as u32 {
            return Err(Error::BadTarget);
        }
        let m = Self::live_market(&e, &token)?;
        let (max_ltv, _) = Self::terms(&m);
        // A multiple of L carries an LTV of (L - 1) / L. Rounded up, so a
        // multiple the market cannot quite hold is refused rather than
        // silently trimmed to one it can.
        let want_ltv = ((leverage_bps as i128 - BPS) * BPS + leverage_bps as i128 - 1)
            / leverage_bps as i128;
        if want_ltv > max_ltv as i128 {
            return Err(Error::BadTarget);
        }
        let price = Self::price(&e, &token)?;

        // The target is stored as an LTV, the same as an Earn's, so the
        // agents hold a multiple without knowing it is one: holding
        // (L - 1) / L IS holding L.
        let target_bps = want_ltv as u32;
        let pos = Self::get_or_deploy(&e, &owner, &m, Product::Amplify, target_bps);
        let p = PositionClient::new(&e, &pos);

        token::Client::new(&e, &token).transfer(&owner, &pos, &amount);
        let advance = amount * (leverage_bps as i128 - BPS) / BPS;
        let owed = advance * price / UNIT;

        // Pledged first, borrowed second. The order is the whole safety
        // argument: at the moment the loan exists, the stock it bought is
        // already collateral behind it.
        Self::buy_stock_from_core(&e, &m, &pos, owed, price);
        p.supply(&(amount + advance));
        p.set_target(&target_bps);
        if owed > 0 {
            p.borrow(&owed, &e.current_contract_address());
        }

        Opened {
            owner,
            market: token,
            position: pos.clone(),
            product: Product::Amplify,
            collateral: amount,
            borrowed: owed,
            target_bps,
        }
        .publish(&e);
        Ok(pos)
    }

    /// The stand-in for a venue: dollars the core is holding turn into stock at
    /// the oracle price. The core is the stock's admin on testnet, so it mints;
    /// the dollars stay here against the day the token is real and this becomes
    /// a route.
    fn buy_stock_from_core(
        e: &Env,
        m: &Market,
        to: &Address,
        usdc_amount: i128,
        price: i128,
    ) -> i128 {
        let units = usdc_amount * UNIT / price;
        e.invoke_contract::<()>(
            &m.token,
            &Symbol::new(e, "mint"),
            Vec::from_array(e, [to.into_val(e), units.into_val(e)]),
        );
        units
    }

    pub fn amplify_close(e: Env, owner: Address, token: Address) -> Result<i128, Error> {
        owner.require_auth();
        let key = Key::Pos(owner.clone(), token.clone(), Product::Amplify);
        let pos: Address = e.storage().instance().get(&key).ok_or(Error::NoPosition)?;
        let p = PositionClient::new(&e, &pos);
        let price = Self::price(&e, &token)?;
        let m = Self::market(&e, &token)?;

        // Selling stock back is the stand-in in reverse: the core takes the
        // stock at the oracle price and pays the dollars it is holding.
        let owed = p.debt();
        if owed > 0 {
            // Repaid first, then the stock that pays for it leaves. The other
            // order takes collateral out from under a live debt, which the
            // pool refuses.
            let usdc = Self::usdc(&e);
            token::Client::new(&e, &usdc).transfer(
                &e.current_contract_address(),
                &p.address,
                &owed,
            );
            p.repay(&owed);
            let units = owed * UNIT / price + 1;
            p.unsupply(&units, &e.current_contract_address());
            let _ = m;
        }
        let left = p.collateral();
        if left > 0 {
            p.unsupply(&left, &owner);
        }

        e.storage().instance().remove(&key);
        Closed { owner, market: token, position: pos, returned: left }.publish(&e);
        Ok(left)
    }

    // ---- liquidation ----

    /// The buffer goes before the liquidator. Only if repaying the position
    /// back to its target out of the buffer does not restore health does
    /// anyone get to take the stock, and that is the point of the whole
    /// design: the counterweight is tried first, every time.
    pub fn liquidate(e: Env, agent: Address, position: Address) -> Result<i128, Error> {
        agent.require_auth();
        let p = PositionClient::new(&e, &position);
        let token = p.stock();
        let m = Self::market(&e, &token)?;
        let price = Self::price(&e, &token)?;
        let (_, threshold) = Self::terms(&m);

        let collateral = p.collateral() * price / UNIT;
        let debt = p.debt();
        if collateral <= 0 || debt * BPS / collateral < threshold as i128 {
            return Err(Error::Healthy);
        }

        let want = Self::debt_at(p.collateral(), price, p.target().min(m.ltv));
        let repay = debt - want;
        if repay > 0 {
            Self::repay_from_buffer(&e, &p, repay)?;
        }

        p.touch(&agent, &symbol_short!("liq"));
        AgentRan { agent, position, action: symbol_short!("liq"), delta: -repay }.publish(&e);
        Ok(repay)
    }

    pub fn version(e: Env) -> String {
        String::from_str(&e, "agama-stellar-core/0.1.0")
    }
}

use soroban_sdk::xdr::ToXdr;

mod test;
