#![no_std]
//! A testnet stand-in for the Agama vault.
//!
//! The live vault takes Circle's USDC, and Circle's USDC cannot be minted by
//! anyone but Circle. On testnet that is a wall, not an inconvenience: without
//! dollars nothing can be supplied to the pool, nothing can be borrowed, and
//! the buffer cannot be funded, so the whole protocol is untestable. This
//! contract exists so the dollar leg is ours end to end.
//!
//! It is not a simplification of the real vault, it is the two properties of
//! the real vault the protocol is built around:
//!
//!   - a deposit lands immediately and mints shares at the current rate,
//!   - a withdrawal does NOT pay out. It joins a queue and settles later.
//!
//! The second one is the reason the core carries a USDC buffer at all. A
//! stand-in that paid out instantly would make every buffer test pass for the
//! wrong reason, so this one refuses to, exactly like the real one.
//!
//! `accrue` is the one thing here with no counterpart in production: it hands
//! the vault yield out of thin air so an agent has something to compound. In
//! production that yield is private credit interest arriving on its own.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env, Vec,
};

/// Shares are minted at the rate implied by assets held per share outstanding,
/// to twelve decimals so a small deposit into a large vault is not rounded to
/// nothing.
const RATE_SCALAR: i128 = 1_000_000_000_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    BadAmount = 1,
    NotAdmin = 2,
    NotEnoughShares = 3,
    NothingQueued = 4,
    NotEnoughCash = 5,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Queued {
    pub id: u64,
    pub owner: Address,
    pub shares: i128,
    pub assets: i128,
    pub at: u64,
    pub paid: bool,
}

#[contracttype]
enum Key {
    Admin,
    Usdc,
    Shares(Address),
    Supply,
    Held,
    NextId,
    Queue(u64),
    Open,
}

#[contractevent]
pub struct Deposit {
    #[topic]
    pub from: Address,
    pub assets: i128,
    pub shares: i128,
}

#[contractevent]
pub struct Requested {
    #[topic]
    pub from: Address,
    pub id: u64,
    pub shares: i128,
    pub assets: i128,
}

#[contractevent]
pub struct Settled {
    #[topic]
    pub to: Address,
    pub id: u64,
    pub assets: i128,
}

#[contractevent]
pub struct Accrued {
    pub amount: i128,
}

#[contract]
pub struct Vault;

#[contractimpl]
impl Vault {
    pub fn __constructor(e: Env, admin: Address, usdc: Address) {
        e.storage().instance().set(&Key::Admin, &admin);
        e.storage().instance().set(&Key::Usdc, &usdc);
        e.storage().instance().set(&Key::Supply, &0i128);
        e.storage().instance().set(&Key::Held, &0i128);
        e.storage().instance().set(&Key::NextId, &1u64);
        e.storage().instance().set(&Key::Open, &Vec::<u64>::new(&e));
    }

    // ---- what a depositor does ----

    /// Dollars in, shares out, settled in this call.
    pub fn deposit(e: Env, from: Address, amount: i128) -> Result<i128, Error> {
        from.require_auth();
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        let usdc: Address = e.storage().instance().get(&Key::Usdc).unwrap();
        token::Client::new(&e, &usdc).transfer(&from, &e.current_contract_address(), &amount);

        let shares = Self::to_shares(&e, amount);
        Self::bump(&e, Key::Supply, shares);
        Self::bump(&e, Key::Held, amount);
        let had: i128 = e.storage().persistent().get(&Key::Shares(from.clone())).unwrap_or(0);
        e.storage().persistent().set(&Key::Shares(from.clone()), &(had + shares));

        Deposit { from, assets: amount, shares }.publish(&e);
        Ok(shares)
    }

    /// File a withdrawal. This pays nothing. It returns a ticket.
    ///
    /// The shares are burned here, at today's rate, so a position cannot file a
    /// withdrawal and keep earning on the way out. What it is owed is fixed at
    /// the moment it asks.
    pub fn request_withdrawal(e: Env, from: Address, amount: i128) -> Result<u64, Error> {
        from.require_auth();
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        let shares = Self::to_shares(&e, amount);
        let had: i128 = e.storage().persistent().get(&Key::Shares(from.clone())).unwrap_or(0);
        if had < shares {
            return Err(Error::NotEnoughShares);
        }
        e.storage().persistent().set(&Key::Shares(from.clone()), &(had - shares));
        Self::bump(&e, Key::Supply, -shares);
        Self::bump(&e, Key::Held, -amount);

        let id: u64 = e.storage().instance().get(&Key::NextId).unwrap();
        e.storage().instance().set(&Key::NextId, &(id + 1));
        e.storage().persistent().set(
            &Key::Queue(id),
            &Queued {
                id,
                owner: from.clone(),
                shares,
                assets: amount,
                at: e.ledger().timestamp(),
                paid: false,
            },
        );
        let mut open: Vec<u64> = e.storage().instance().get(&Key::Open).unwrap();
        open.push_back(id);
        e.storage().instance().set(&Key::Open, &open);

        Requested { from, id, shares, assets: amount }.publish(&e);
        Ok(id)
    }

    // ---- what the operator does ----

    /// Pay a queued ticket. In production this is the cash calendar coming
    /// round; here it is an admin call, so a test can decide when it happens.
    pub fn settle(e: Env, id: u64) -> Result<i128, Error> {
        Self::admin(&e).require_auth();
        let mut q: Queued =
            e.storage().persistent().get(&Key::Queue(id)).ok_or(Error::NothingQueued)?;
        if q.paid {
            return Err(Error::NothingQueued);
        }
        let usdc: Address = e.storage().instance().get(&Key::Usdc).unwrap();
        let t = token::Client::new(&e, &usdc);
        if t.balance(&e.current_contract_address()) < q.assets {
            return Err(Error::NotEnoughCash);
        }
        t.transfer(&e.current_contract_address(), &q.owner, &q.assets);
        q.paid = true;
        e.storage().persistent().set(&Key::Queue(id), &q);

        let open: Vec<u64> = e.storage().instance().get(&Key::Open).unwrap();
        let mut left = Vec::new(&e);
        for x in open.iter() {
            if x != id {
                left.push_back(x);
            }
        }
        e.storage().instance().set(&Key::Open, &left);

        Settled { to: q.owner, id, assets: q.assets }.publish(&e);
        Ok(q.assets)
    }

    /// Yield arrives. Every share is worth more and nobody's share count moved,
    /// which is what a yield-bearing position looks like from outside.
    pub fn accrue(e: Env, amount: i128) -> Result<(), Error> {
        Self::admin(&e).require_auth();
        if amount <= 0 {
            return Err(Error::BadAmount);
        }
        let usdc: Address = e.storage().instance().get(&Key::Usdc).unwrap();
        token::Client::new(&e, &usdc).transfer(
            &Self::admin(&e),
            &e.current_contract_address(),
            &amount,
        );
        Self::bump(&e, Key::Held, amount);
        Accrued { amount }.publish(&e);
        Ok(())
    }

    // ---- what anyone can read ----

    pub fn shares(e: Env, of: Address) -> i128 {
        e.storage().persistent().get(&Key::Shares(of)).unwrap_or(0)
    }

    /// What a holder's shares are worth today.
    pub fn assets_of(e: Env, of: Address) -> i128 {
        let shares = Self::shares(e.clone(), of);
        let supply: i128 = e.storage().instance().get(&Key::Supply).unwrap();
        if supply == 0 {
            return 0;
        }
        let held: i128 = e.storage().instance().get(&Key::Held).unwrap();
        shares * held / supply
    }

    pub fn total_assets(e: Env) -> i128 {
        e.storage().instance().get(&Key::Held).unwrap()
    }

    pub fn total_shares(e: Env) -> i128 {
        e.storage().instance().get(&Key::Supply).unwrap()
    }

    /// Dollars per share, to twelve decimals. One to one on an empty vault.
    pub fn rate(e: Env) -> i128 {
        let supply: i128 = e.storage().instance().get(&Key::Supply).unwrap();
        if supply == 0 {
            return RATE_SCALAR;
        }
        let held: i128 = e.storage().instance().get(&Key::Held).unwrap();
        held * RATE_SCALAR / supply
    }

    pub fn queued(e: Env, id: u64) -> Option<Queued> {
        e.storage().persistent().get(&Key::Queue(id))
    }

    pub fn open_queue(e: Env) -> Vec<u64> {
        e.storage().instance().get(&Key::Open).unwrap()
    }

    pub fn usdc(e: Env) -> Address {
        e.storage().instance().get(&Key::Usdc).unwrap()
    }

    // ---- inside ----

    fn admin(e: &Env) -> Address {
        e.storage().instance().get(&Key::Admin).unwrap()
    }

    fn to_shares(e: &Env, assets: i128) -> i128 {
        let supply: i128 = e.storage().instance().get(&Key::Supply).unwrap();
        if supply == 0 {
            return assets;
        }
        let held: i128 = e.storage().instance().get(&Key::Held).unwrap();
        assets * supply / held
    }

    fn bump(e: &Env, k: Key, by: i128) {
        let now: i128 = e.storage().instance().get(&k).unwrap_or(0);
        e.storage().instance().set(&k, &(now + by));
    }
}

mod test;
