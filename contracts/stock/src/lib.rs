#![no_std]
//! A stand-in tokenized stock, SEP-41, with a public faucet.
//!
//! No tokenized equity exists on Stellar yet; DTCC's is coming. Until it does,
//! each market in this repository is backed by one instance of this contract:
//! the same wasm deployed ten times with different metadata, so a market is an
//! address rather than a special case in the code. When the real tokens land, a
//! market points at one of those instead and nothing else moves.
//!
//! The faucet is the whole reason this is not just a token. It is open to
//! anyone, it mints a fixed quantity rather than an amount the caller chooses,
//! and it is rate limited per address. A faucet that takes an amount is a mint
//! function with a friendly name: anyone can ask for a billion shares, and the
//! prices this protocol runs on are real, so that would be a real position.
//!
//! Decimals are 7 throughout, which is Stellar's own convention and what the
//! Agama vault on this network already uses.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, symbol_short, Address, Env,
    String, Symbol,
};

/// SEP-41's events, declared rather than published as loose tuples: the macro
/// puts them in the contract spec, so an indexer reads the shape instead of
/// guessing it.
#[contractevent(topics = ["transfer"])]
pub struct Transfer {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[contractevent(topics = ["approve"])]
pub struct Approve {
    #[topic]
    pub from: Address,
    #[topic]
    pub spender: Address,
    pub amount: i128,
    pub expiration_ledger: u32,
}

#[contractevent(topics = ["burn"])]
pub struct Burn {
    #[topic]
    pub from: Address,
    pub amount: i128,
}

#[contractevent(topics = ["mint"])]
pub struct Mint {
    #[topic]
    pub to: Address,
    pub amount: i128,
}

/// Not SEP-41: what makes this token a stand-in rather than an asset.
#[contractevent(topics = ["faucet"])]
pub struct Faucet {
    #[topic]
    pub to: Address,
    pub amount: i128,
}

/// Instance storage lives as long as the contract is used; the TTL is bumped on
/// every write so an active token never has to be restored.
const DAY: u32 = 17_280; // ledgers, at roughly 5 seconds each
const INSTANCE_TTL: u32 = 30 * DAY;
const INSTANCE_BUMP: u32 = 7 * DAY;
/// Balances outlive a quiet holder: a year of not touching a position is normal.
const ENTRY_TTL: u32 = 365 * DAY;
const ENTRY_BUMP: u32 = 30 * DAY;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NegativeAmount = 1,
    InsufficientBalance = 2,
    InsufficientAllowance = 3,
    AllowanceExpired = 4,
    FaucetCooldown = 5,
}

#[derive(Clone)]
#[contracttype]
enum Key {
    Admin,
    /// What one faucet call hands out, in stroops of this token.
    Drip,
    /// Seconds a holder must wait between two faucet calls.
    Cooldown,
    Balance(Address),
    /// (from, spender)
    Allowance(Address, Address),
    /// Last ledger timestamp at which this address drew from the faucet.
    LastDrip(Address),
}

#[derive(Clone)]
#[contracttype]
pub struct AllowanceValue {
    pub amount: i128,
    /// Ledger sequence after which the allowance is dead, SEP-41's own rule.
    pub expiration_ledger: u32,
}

fn bump_instance(e: &Env) {
    e.storage().instance().extend_ttl(INSTANCE_BUMP, INSTANCE_TTL);
}

fn read_balance(e: &Env, id: &Address) -> i128 {
    let key = Key::Balance(id.clone());
    match e.storage().persistent().get::<_, i128>(&key) {
        Some(b) => {
            e.storage().persistent().extend_ttl(&key, ENTRY_BUMP, ENTRY_TTL);
            b
        }
        None => 0,
    }
}

fn write_balance(e: &Env, id: &Address, amount: i128) {
    let key = Key::Balance(id.clone());
    e.storage().persistent().set(&key, &amount);
    e.storage().persistent().extend_ttl(&key, ENTRY_BUMP, ENTRY_TTL);
}

fn check_positive(amount: i128) -> Result<(), Error> {
    if amount < 0 {
        return Err(Error::NegativeAmount);
    }
    Ok(())
}

fn spend_balance(e: &Env, from: &Address, amount: i128) -> Result<(), Error> {
    check_positive(amount)?;
    let balance = read_balance(e, from);
    if balance < amount {
        return Err(Error::InsufficientBalance);
    }
    write_balance(e, from, balance - amount);
    Ok(())
}

fn receive_balance(e: &Env, to: &Address, amount: i128) -> Result<(), Error> {
    check_positive(amount)?;
    write_balance(e, to, read_balance(e, to) + amount);
    Ok(())
}

fn read_allowance(e: &Env, from: &Address, spender: &Address) -> AllowanceValue {
    let key = Key::Allowance(from.clone(), spender.clone());
    match e.storage().temporary().get::<_, AllowanceValue>(&key) {
        Some(a) if a.expiration_ledger >= e.ledger().sequence() => a,
        // An expired allowance reads as nothing rather than as a stale number:
        // SEP-41 lets the entry outlive its expiry and the reader must not.
        _ => AllowanceValue { amount: 0, expiration_ledger: 0 },
    }
}

fn spend_allowance(e: &Env, from: &Address, spender: &Address, amount: i128) -> Result<(), Error> {
    let allowance = read_allowance(e, from, spender);
    if allowance.amount < amount {
        return Err(Error::InsufficientAllowance);
    }
    if amount == 0 {
        return Ok(());
    }
    let key = Key::Allowance(from.clone(), spender.clone());
    let next = AllowanceValue {
        amount: allowance.amount - amount,
        expiration_ledger: allowance.expiration_ledger,
    };
    e.storage().temporary().set(&key, &next);
    let live = allowance.expiration_ledger.saturating_sub(e.ledger().sequence());
    e.storage().temporary().extend_ttl(&key, live, live);
    Ok(())
}

#[contract]
pub struct Stock;

#[contractimpl]
impl Stock {
    /// `drip` is what one faucet call hands out and `cooldown` the seconds
    /// between two of them, both fixed at deploy so a market cannot be refilled
    /// at will once it is priced by a real oracle.
    pub fn __constructor(
        e: Env,
        admin: Address,
        decimals: u32,
        name: String,
        symbol: String,
        drip: i128,
        cooldown: u64,
    ) -> Result<(), Error> {
        check_positive(drip)?;
        e.storage().instance().set(&Key::Admin, &admin);
        e.storage().instance().set(&Key::Drip, &drip);
        e.storage().instance().set(&Key::Cooldown, &cooldown);
        e.storage().instance().set(&symbol_short!("DEC"), &decimals);
        e.storage().instance().set(&symbol_short!("NAME"), &name);
        e.storage().instance().set(&symbol_short!("SYM"), &symbol);
        bump_instance(&e);
        Ok(())
    }

    // ---- the faucet ----

    /// Hand `drip` of this token to `to`, once per cooldown. Open to anyone:
    /// `to` authorises so a caller cannot burn someone else's cooldown.
    pub fn faucet(e: Env, to: Address) -> Result<i128, Error> {
        to.require_auth();
        let cooldown: u64 = e.storage().instance().get(&Key::Cooldown).unwrap();
        let now = e.ledger().timestamp();
        let key = Key::LastDrip(to.clone());
        if let Some(last) = e.storage().persistent().get::<_, u64>(&key) {
            if now < last + cooldown {
                return Err(Error::FaucetCooldown);
            }
        }
        e.storage().persistent().set(&key, &now);
        e.storage().persistent().extend_ttl(&key, ENTRY_BUMP, ENTRY_TTL);

        let drip: i128 = e.storage().instance().get(&Key::Drip).unwrap();
        receive_balance(&e, &to, drip)?;
        bump_instance(&e);
        Faucet { to, amount: drip }.publish(&e);
        Ok(drip)
    }

    /// Seconds `who` still has to wait, 0 when the faucet is ready.
    pub fn faucet_in(e: Env, who: Address) -> u64 {
        let cooldown: u64 = e.storage().instance().get(&Key::Cooldown).unwrap();
        match e.storage().persistent().get::<_, u64>(&Key::LastDrip(who)) {
            Some(last) => (last + cooldown).saturating_sub(e.ledger().timestamp()),
            None => 0,
        }
    }

    pub fn drip(e: Env) -> i128 {
        e.storage().instance().get(&Key::Drip).unwrap()
    }

    // ---- admin ----

    /// Seeding the Blend pool and the demo liquidity. Not open, unlike the faucet.
    pub fn mint(e: Env, to: Address, amount: i128) -> Result<(), Error> {
        let admin: Address = e.storage().instance().get(&Key::Admin).unwrap();
        admin.require_auth();
        receive_balance(&e, &to, amount)?;
        bump_instance(&e);
        Mint { to, amount }.publish(&e);
        Ok(())
    }

    pub fn admin(e: Env) -> Address {
        e.storage().instance().get(&Key::Admin).unwrap()
    }

    pub fn set_admin(e: Env, new_admin: Address) {
        let admin: Address = e.storage().instance().get(&Key::Admin).unwrap();
        admin.require_auth();
        e.storage().instance().set(&Key::Admin, &new_admin);
        bump_instance(&e);
    }

    // ---- SEP-41 ----

    pub fn allowance(e: Env, from: Address, spender: Address) -> i128 {
        read_allowance(&e, &from, &spender).amount
    }

    pub fn approve(
        e: Env,
        from: Address,
        spender: Address,
        amount: i128,
        expiration_ledger: u32,
    ) -> Result<(), Error> {
        from.require_auth();
        check_positive(amount)?;
        if amount > 0 && expiration_ledger < e.ledger().sequence() {
            return Err(Error::AllowanceExpired);
        }
        let key = Key::Allowance(from.clone(), spender.clone());
        e.storage()
            .temporary()
            .set(&key, &AllowanceValue { amount, expiration_ledger });
        if amount > 0 {
            let live = expiration_ledger - e.ledger().sequence();
            e.storage().temporary().extend_ttl(&key, live, live);
        }
        Approve { from, spender, amount, expiration_ledger }.publish(&e);
        Ok(())
    }

    pub fn balance(e: Env, id: Address) -> i128 {
        read_balance(&e, &id)
    }

    pub fn transfer(e: Env, from: Address, to: Address, amount: i128) -> Result<(), Error> {
        from.require_auth();
        spend_balance(&e, &from, amount)?;
        receive_balance(&e, &to, amount)?;
        Transfer { from, to, amount }.publish(&e);
        Ok(())
    }

    pub fn transfer_from(
        e: Env,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), Error> {
        spender.require_auth();
        spend_allowance(&e, &from, &spender, amount)?;
        spend_balance(&e, &from, amount)?;
        receive_balance(&e, &to, amount)?;
        Transfer { from, to, amount }.publish(&e);
        Ok(())
    }

    pub fn burn(e: Env, from: Address, amount: i128) -> Result<(), Error> {
        from.require_auth();
        spend_balance(&e, &from, amount)?;
        Burn { from, amount }.publish(&e);
        Ok(())
    }

    pub fn burn_from(e: Env, spender: Address, from: Address, amount: i128) -> Result<(), Error> {
        spender.require_auth();
        spend_allowance(&e, &from, &spender, amount)?;
        spend_balance(&e, &from, amount)?;
        Burn { from, amount }.publish(&e);
        Ok(())
    }

    pub fn decimals(e: Env) -> u32 {
        e.storage().instance().get(&symbol_short!("DEC")).unwrap()
    }

    pub fn name(e: Env) -> String {
        e.storage().instance().get::<Symbol, String>(&symbol_short!("NAME")).unwrap()
    }

    pub fn symbol(e: Env) -> String {
        e.storage().instance().get::<Symbol, String>(&symbol_short!("SYM")).unwrap()
    }
}

mod test;
