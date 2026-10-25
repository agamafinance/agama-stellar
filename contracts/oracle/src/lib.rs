#![no_std]
//! The price layer: RedStone reports verified on chain, answered as SEP-40.
//!
//! Stellar has no equity feed, from anyone. RedStone publishes one off chain
//! and signs it; this contract is what turns a signature into a price a lending
//! pool can act on, without anybody in between being trusted.
//!
//! `push` takes a RedStone payload as RedStone produced it and is open to
//! everyone. It recovers the signer of every package, keeps only the ones on
//! the allow list, requires at least `min_signers` distinct ones per feed, and
//! takes the median of what they said. A keeper that relays reports therefore
//! holds no price key: it chooses when a price is refreshed, never what it is.
//!
//! On the way in a price is bounded three ways, because a verified report is
//! not the same thing as a sane one:
//!
//! - its timestamp must be strictly newer than the stored one, so a report
//!   applies once and a replayed one never;
//! - it must be younger than `max_age`, so a true report from last week cannot
//!   be relayed as today's;
//! - it may move the stored price by at most `max_move_bps` in one call, so a
//!   feed that goes wrong walks rather than jumps, and converges if it was
//!   right after all.
//!
//! The contract answers SEP-40, which is the interface a Blend pool reads. That
//! is the whole reason it is shaped this way rather than as a private getter:
//! the pool talks to the oracle, not to us.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Bytes, BytesN,
    Env, Map, Symbol, Vec,
};

mod redstone;
use redstone::ParseError;

const DAY: u32 = 17_280;
const INSTANCE_TTL: u32 = 30 * DAY;
const INSTANCE_BUMP: u32 = 7 * DAY;
const ENTRY_TTL: u32 = 30 * DAY;
const ENTRY_BUMP: u32 = 7 * DAY;

const BPS: i128 = 10_000;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotRedStone = 1,
    Truncated = 2,
    NoPackages = 3,
    ValueTooWide = 4,
    BadRecoveryId = 5,
    /// Fewer allowed signers agreed on a feed than `min_signers` demands.
    NotEnoughSigners = 6,
    /// The report is older than `max_age`.
    Stale = 7,
    /// Its timestamp is not strictly newer than the one already stored.
    NotNewer = 8,
    /// Nothing in the payload matched a feed this oracle carries.
    NoKnownFeed = 9,
    UnknownAsset = 10,
    AlreadyRegistered = 11,
    BadParams = 12,
}

impl From<ParseError> for Error {
    fn from(e: ParseError) -> Self {
        match e {
            ParseError::NotRedStone => Error::NotRedStone,
            ParseError::Truncated => Error::Truncated,
            ParseError::NoPackages => Error::NoPackages,
            ParseError::ValueTooWide => Error::ValueTooWide,
            ParseError::BadRecoveryId => Error::BadRecoveryId,
        }
    }
}

/// SEP-40's own types. An asset is either a contract on this network or a
/// ticker that has none, which is how a share with no token yet still has a
/// price here.
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

#[derive(Clone)]
#[contracttype]
enum Key {
    Admin,
    /// The Ethereum addresses whose signature counts.
    Signers,
    MinSigners,
    Decimals,
    MaxAge,
    MaxMoveBps,
    /// Every asset this oracle answers for, in the order they were added.
    Assets,
    /// asset -> RedStone feed id, the 32 bytes of the right padded ticker.
    Feed(Asset),
    /// feed id -> asset, so a payload finds its way without a caller saying so.
    ByFeed(BytesN<32>),
    Last(Asset),
}

#[contractevent(topics = ["feed"])]
pub struct Retargeted {
    pub asset: Asset,
    pub feed: BytesN<32>,
}

#[contractevent(topics = ["price"])]
pub struct Priced {
    #[topic]
    pub asset: Asset,
    pub price: i128,
    pub timestamp: u64,
    /// How many allowed signers agreed. Worth recording: it is the one number
    /// that says how much the price was actually attested, and it varies.
    pub signers: u32,
}

#[contract]
pub struct Oracle;

#[contractimpl]
impl Oracle {
    /// `decimals` is what this oracle reports in, not what RedStone sends:
    /// RedStone is 8, Stellar's convention is 7, and the conversion happens
    /// once here rather than in every reader.
    pub fn __constructor(
        e: Env,
        admin: Address,
        signers: Vec<BytesN<20>>,
        min_signers: u32,
        decimals: u32,
        max_age: u64,
        max_move_bps: u32,
    ) -> Result<(), Error> {
        if min_signers == 0 || min_signers > signers.len() || decimals > 18 || max_move_bps == 0 {
            return Err(Error::BadParams);
        }
        e.storage().instance().set(&Key::Admin, &admin);
        e.storage().instance().set(&Key::Signers, &signers);
        e.storage().instance().set(&Key::MinSigners, &min_signers);
        e.storage().instance().set(&Key::Decimals, &decimals);
        e.storage().instance().set(&Key::MaxAge, &max_age);
        e.storage().instance().set(&Key::MaxMoveBps, &max_move_bps);
        e.storage().instance().set(&Key::Assets, &Vec::<Asset>::new(&e));
        e.storage().instance().extend_ttl(INSTANCE_BUMP, INSTANCE_TTL);
        Ok(())
    }

    fn admin(e: &Env) -> Address {
        e.storage().instance().get(&Key::Admin).unwrap()
    }

    /// Bind an asset to the RedStone feed that prices it. The feed id is the
    /// ticker as 32 bytes, right padded with zeros, which is how RedStone
    /// writes it in a data point.
    pub fn add_feed(e: Env, asset: Asset, feed: BytesN<32>) -> Result<(), Error> {
        Self::admin(&e).require_auth();
        if e.storage().instance().has(&Key::Feed(asset.clone())) {
            return Err(Error::AlreadyRegistered);
        }
        let mut assets: Vec<Asset> = e.storage().instance().get(&Key::Assets).unwrap();
        assets.push_back(asset.clone());
        e.storage().instance().set(&Key::Assets, &assets);
        e.storage().instance().set(&Key::Feed(asset.clone()), &feed);
        e.storage().instance().set(&Key::ByFeed(feed), &asset);
        e.storage().instance().extend_ttl(INSTANCE_BUMP, INSTANCE_TTL);
        Ok(())
    }

    /// Point an asset at a different feed.
    ///
    /// Not a convenience. RedStone renames a feed when its source changes, and
    /// carries some tickers only under a decorated name: there is no `SPY`
    /// package, there is `SPY---PRE_AFTER`. Without this, a rename means
    /// redeploying the oracle, which means repointing the pool and the core,
    /// which on a protocol whose core owns its tokens means redeploying the
    /// tokens. One missing admin function, and the blast radius is the whole
    /// deployment. The live testnet oracle predates this function and pays
    /// exactly that price: two of its ten markets stay admin-priced.
    ///
    /// The old feed id is unbound as well as the new one bound. Leaving it
    /// would let a report carrying the old ticker keep writing this asset's
    /// price after it was deliberately moved away from it.
    pub fn retarget_feed(e: Env, asset: Asset, feed: BytesN<32>) -> Result<(), Error> {
        Self::admin(&e).require_auth();
        let old: BytesN<32> = e
            .storage()
            .instance()
            .get(&Key::Feed(asset.clone()))
            .ok_or(Error::UnknownAsset)?;
        if old == feed {
            return Ok(());
        }
        if e.storage().instance().has(&Key::ByFeed(feed.clone())) {
            return Err(Error::AlreadyRegistered);
        }
        e.storage().instance().remove(&Key::ByFeed(old));
        e.storage().instance().set(&Key::Feed(asset.clone()), &feed);
        e.storage().instance().set(&Key::ByFeed(feed.clone()), &asset);
        e.storage().instance().extend_ttl(INSTANCE_BUMP, INSTANCE_TTL);
        Retargeted { asset, feed }.publish(&e);
        Ok(())
    }

    /// Replace the code behind this address, keeping the storage.
    ///
    /// The reason this exists is the paragraph above: an oracle that cannot be
    /// fixed in place forces everything that reads it to be replaced too.
    pub fn upgrade(e: Env, new_wasm_hash: BytesN<32>) {
        Self::admin(&e).require_auth();
        e.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    pub fn set_signers(e: Env, signers: Vec<BytesN<20>>, min_signers: u32) -> Result<(), Error> {
        Self::admin(&e).require_auth();
        if min_signers == 0 || min_signers > signers.len() {
            return Err(Error::BadParams);
        }
        e.storage().instance().set(&Key::Signers, &signers);
        e.storage().instance().set(&Key::MinSigners, &min_signers);
        e.storage().instance().extend_ttl(INSTANCE_BUMP, INSTANCE_TTL);
        Ok(())
    }

    /// Relay a RedStone payload. Open to anyone; what it carries is what
    /// decides, not who sent it. Returns how many assets it moved.
    pub fn push(e: Env, payload: Bytes) -> Result<u32, Error> {
        let quotes = redstone::parse(&e, &payload)?;
        let allowed: Vec<BytesN<20>> = e.storage().instance().get(&Key::Signers).unwrap();
        let min_signers: u32 = e.storage().instance().get(&Key::MinSigners).unwrap();
        let decimals: u32 = e.storage().instance().get(&Key::Decimals).unwrap();
        let max_age: u64 = e.storage().instance().get(&Key::MaxAge).unwrap();
        let max_move_bps: i128 =
            e.storage().instance().get::<_, u32>(&Key::MaxMoveBps).unwrap() as i128;
        let now = e.ledger().timestamp();

        // Gather per feed, keeping one value per distinct allowed signer. A
        // signer that repeats itself across packages counts once: the rule is
        // about how many independent parties said it.
        let mut values: Map<BytesN<32>, Vec<i128>> = Map::new(&e);
        let mut seen: Map<BytesN<32>, Vec<BytesN<20>>> = Map::new(&e);
        let mut stamp: Map<BytesN<32>, u64> = Map::new(&e);

        for q in quotes.iter() {
            if !allowed.contains(&q.signer) {
                continue;
            }
            if !e.storage().instance().has(&Key::ByFeed(q.feed.clone())) {
                continue;
            }
            let mut signers = seen.get(q.feed.clone()).unwrap_or(Vec::new(&e));
            if signers.contains(&q.signer) {
                continue;
            }
            signers.push_back(q.signer.clone());
            seen.set(q.feed.clone(), signers);

            let mut vs = values.get(q.feed.clone()).unwrap_or(Vec::new(&e));
            vs.push_back(q.value);
            values.set(q.feed.clone(), vs);

            // Packages in one payload share a timestamp; take the oldest, so a
            // mixed payload is judged on its weakest part.
            let t = stamp.get(q.feed.clone()).map_or(q.timestamp, |s| s.min(q.timestamp));
            stamp.set(q.feed.clone(), t);
        }

        if values.is_empty() {
            return Err(Error::NoKnownFeed);
        }

        let mut applied = 0u32;
        for (feed, vs) in values.iter() {
            let count = vs.len();
            if count < min_signers {
                return Err(Error::NotEnoughSigners);
            }
            let timestamp = stamp.get(feed.clone()).unwrap();
            if now > timestamp && now - timestamp > max_age {
                return Err(Error::Stale);
            }

            let asset: Asset = e.storage().instance().get(&Key::ByFeed(feed)).unwrap();
            let raw = median(&e, vs);
            // RedStone reports at 8 decimals.
            let price = rescale(raw, 8, decimals);

            let key = Key::Last(asset.clone());
            let next = match e.storage().persistent().get::<_, PriceData>(&key) {
                Some(prev) => {
                    if timestamp <= prev.timestamp {
                        return Err(Error::NotNewer);
                    }
                    PriceData { price: bound(prev.price, price, max_move_bps), timestamp }
                }
                None => PriceData { price, timestamp },
            };
            e.storage().persistent().set(&key, &next);
            e.storage().persistent().extend_ttl(&key, ENTRY_BUMP, ENTRY_TTL);

            Priced { asset, price: next.price, timestamp, signers: count }.publish(&e);
            applied += 1;
        }

        e.storage().instance().extend_ttl(INSTANCE_BUMP, INSTANCE_TTL);
        Ok(applied)
    }

    /// The unverified path, admin only, for the day a feed is wrong and waiting
    /// for the next report is the more expensive option. Bounded like the
    /// verified one: an emergency is not a reason to let a price jump.
    pub fn set_price(e: Env, asset: Asset, price: i128) -> Result<(), Error> {
        Self::admin(&e).require_auth();
        if !e.storage().instance().has(&Key::Feed(asset.clone())) {
            return Err(Error::UnknownAsset);
        }
        let timestamp = e.ledger().timestamp();
        let max_move_bps: i128 =
            e.storage().instance().get::<_, u32>(&Key::MaxMoveBps).unwrap() as i128;
        let key = Key::Last(asset.clone());
        let next = match e.storage().persistent().get::<_, PriceData>(&key) {
            Some(prev) => PriceData { price: bound(prev.price, price, max_move_bps), timestamp },
            None => PriceData { price, timestamp },
        };
        e.storage().persistent().set(&key, &next);
        e.storage().persistent().extend_ttl(&key, ENTRY_BUMP, ENTRY_TTL);
        Priced { asset, price: next.price, timestamp, signers: 0 }.publish(&e);
        Ok(())
    }

    // ---- SEP-40 ----

    /// Prices are against the dollar, which has no contract here.
    pub fn base(e: Env) -> Asset {
        Asset::Other(Symbol::new(&e, "USD"))
    }

    pub fn assets(e: Env) -> Vec<Asset> {
        e.storage().instance().get(&Key::Assets).unwrap()
    }

    pub fn decimals(e: Env) -> u32 {
        e.storage().instance().get(&Key::Decimals).unwrap()
    }

    /// Reports are event driven, not on a tick, so there is no resolution to
    /// promise. SEP-40 wants a number; this is the freshness the oracle will
    /// still answer with, which is the honest one to publish.
    pub fn resolution(e: Env) -> u32 {
        e.storage().instance().get::<_, u64>(&Key::MaxAge).unwrap() as u32
    }

    pub fn lastprice(e: Env, asset: Asset) -> Option<PriceData> {
        e.storage().persistent().get(&Key::Last(asset))
    }

    /// SEP-40 asks for a price at a past timestamp. This oracle keeps the last
    /// one only, so it answers for that one and nothing else rather than
    /// returning a number that is not what was asked for.
    pub fn price(e: Env, asset: Asset, timestamp: u64) -> Option<PriceData> {
        match e.storage().persistent().get::<_, PriceData>(&Key::Last(asset)) {
            Some(p) if p.timestamp == timestamp => Some(p),
            _ => None,
        }
    }

    pub fn prices(e: Env, asset: Asset, records: u32) -> Option<Vec<PriceData>> {
        if records == 0 {
            return None;
        }
        e.storage()
            .persistent()
            .get::<_, PriceData>(&Key::Last(asset))
            .map(|p| Vec::from_array(&e, [p]))
    }

    pub fn max_age(e: Env) -> u64 {
        e.storage().instance().get(&Key::MaxAge).unwrap()
    }

    pub fn signers(e: Env) -> Vec<BytesN<20>> {
        e.storage().instance().get(&Key::Signers).unwrap()
    }

    pub fn min_signers(e: Env) -> u32 {
        e.storage().instance().get(&Key::MinSigners).unwrap()
    }

    pub fn feed(e: Env, asset: Asset) -> Option<BytesN<32>> {
        e.storage().instance().get(&Key::Feed(asset))
    }
}

/// The middle value, or the lower of the two middles on an even count. Not the
/// mean: one signer with a broken feed should not be able to drag the answer,
/// and with a median it cannot unless it is the majority.
fn median(e: &Env, values: Vec<i128>) -> i128 {
    let mut sorted: Vec<i128> = Vec::new(e);
    for v in values.iter() {
        let mut at = sorted.len();
        for (i, s) in sorted.iter().enumerate() {
            if v < s {
                at = i as u32;
                break;
            }
        }
        sorted.insert(at, v);
    }
    sorted.get((sorted.len() - 1) / 2).unwrap()
}

/// `from` decimals to `to`, the only arithmetic between RedStone's convention
/// and Stellar's.
fn rescale(value: i128, from: u32, to: u32) -> i128 {
    if from == to {
        return value;
    }
    let mut v = value;
    if from > to {
        for _ in 0..(from - to) {
            v /= 10;
        }
    } else {
        for _ in 0..(to - from) {
            v = v.saturating_mul(10);
        }
    }
    v
}

/// At most `max_bps` of the previous price in one step, in whichever direction
/// the report points. A feed that goes wrong therefore walks instead of
/// jumping, and a feed that was right converges over a few reports.
fn bound(prev: i128, next: i128, max_bps: i128) -> i128 {
    if prev <= 0 {
        return next;
    }
    let limit = prev * max_bps / BPS;
    if next > prev + limit {
        prev + limit
    } else if next < prev - limit {
        (prev - limit).max(1)
    } else {
        next
    }
}

mod test;
