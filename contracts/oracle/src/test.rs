#![cfg(test)]
extern crate std;

use super::*;
use k256::ecdsa::SigningKey;
use sha3::{Digest, Keccak256};
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{vec, Env};
use std::vec::Vec as StdVec;

const MARKER: [u8; 9] = [0x00, 0x00, 0x02, 0xed, 0x57, 0x01, 0x1e, 0x00, 0x00];
const MAX_AGE: u64 = 600;
const MAX_MOVE_BPS: u32 = 1500;

/// A fixed key is better than a random one here: the same bytes produce the
/// same signer on every run, so a failure is the contract's and not the
/// fixture's.
fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32].into()).unwrap()
}

fn eth_address(k: &SigningKey) -> [u8; 20] {
    let point = k.verifying_key().to_encoded_point(false);
    let hash = Keccak256::digest(&point.as_bytes()[1..]);
    let mut out = [0u8; 20];
    out.copy_from_slice(&hash[12..]);
    out
}

/// A feed id is the ticker as 32 bytes, right padded with zeros.
fn feed_id(ticker: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[..ticker.len()].copy_from_slice(ticker.as_bytes());
    out
}

/// One package: the points, the trailer, and a signature over both.
fn package(k: &SigningKey, points: &[(&str, i128)], ts_ms: u64) -> StdVec<u8> {
    let mut body = StdVec::new();
    for (ticker, value) in points {
        body.extend_from_slice(&feed_id(ticker));
        let mut v = [0u8; 32];
        v[16..].copy_from_slice(&(*value as u128).to_be_bytes());
        body.extend_from_slice(&v);
    }
    body.extend_from_slice(&ts_ms.to_be_bytes()[2..]); // 6 bytes
    body.extend_from_slice(&32u32.to_be_bytes()); // value size
    body.extend_from_slice(&(points.len() as u32).to_be_bytes()[1..]); // 3 bytes

    let digest = Keccak256::digest(&body);
    let (sig, rec) = k.sign_prehash_recoverable(&digest).unwrap();
    let mut out = body;
    out.extend_from_slice(&sig.to_bytes());
    out.push(rec.to_byte() + 27);
    out
}

/// A whole payload: packages, their count, no metadata, the marker.
fn payload(packages: &[StdVec<u8>]) -> StdVec<u8> {
    let mut out = StdVec::new();
    for p in packages {
        out.extend_from_slice(p);
    }
    out.extend_from_slice(&(packages.len() as u16).to_be_bytes());
    out.extend_from_slice(&[0u8; 3]); // metadata size
    out.extend_from_slice(&MARKER);
    out
}

struct Fixture {
    e: Env,
    c: OracleClient<'static>,
    tsla: Asset,
}

fn setup(min_signers: u32) -> Fixture {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().set_timestamp(1_700_000_000);

    let admin = Address::generate(&e);
    let signers = vec![
        &e,
        BytesN::from_array(&e, &eth_address(&key(1))),
        BytesN::from_array(&e, &eth_address(&key(2))),
        BytesN::from_array(&e, &eth_address(&key(3))),
    ];
    let id = e.register(
        Oracle,
        (admin, signers, min_signers, 7u32, MAX_AGE, MAX_MOVE_BPS),
    );
    let c = OracleClient::new(&e, &id);

    let tsla = Asset::Other(Symbol::new(&e, "TSLA"));
    c.add_feed(&tsla, &BytesN::from_array(&e, &feed_id("TSLA")));
    Fixture { e, c, tsla }
}

fn push(f: &Fixture, bytes: StdVec<u8>) -> u32 {
    f.c.push(&Bytes::from_slice(&f.e, &bytes))
}

fn try_push(f: &Fixture, bytes: StdVec<u8>) -> Result<Result<u32, soroban_sdk::ConversionError>, Result<Error, soroban_sdk::InvokeError>> {
    f.c.try_push(&Bytes::from_slice(&f.e, &bytes))
}

// 420.00000000 at RedStone's 8 decimals.
const P420: i128 = 42_000_000_000;

#[test]
fn a_payload_signed_by_enough_known_keys_sets_the_price() {
    let f = setup(2);
    let now = f.e.ledger().timestamp() * 1000;
    let n = push(
        &f,
        payload(&[
            package(&key(1), &[("TSLA", P420)], now),
            package(&key(2), &[("TSLA", P420)], now),
        ]),
    );
    assert_eq!(n, 1);

    let p = f.c.lastprice(&f.tsla).unwrap();
    // 8 decimals in, 7 out.
    assert_eq!(p.price, 4_200_000_000);
    assert_eq!(p.timestamp, now / 1000);
}

#[test]
fn a_stranger_does_not_count_however_well_it_signs() {
    let f = setup(2);
    let now = f.e.ledger().timestamp() * 1000;
    // key(9) is a perfectly valid secp256k1 key. It is simply not on the list.
    let r = try_push(
        &f,
        payload(&[
            package(&key(1), &[("TSLA", P420)], now),
            package(&key(9), &[("TSLA", P420)], now),
        ]),
    );
    assert_eq!(r, Err(Ok(Error::NotEnoughSigners)));
    assert!(f.c.lastprice(&f.tsla).is_none());
}

#[test]
fn one_signer_short_is_refused() {
    let f = setup(3);
    let now = f.e.ledger().timestamp() * 1000;
    let r = try_push(
        &f,
        payload(&[
            package(&key(1), &[("TSLA", P420)], now),
            package(&key(2), &[("TSLA", P420)], now),
        ]),
    );
    assert_eq!(r, Err(Ok(Error::NotEnoughSigners)));
}

#[test]
fn the_same_signer_twice_is_still_one_signer() {
    let f = setup(2);
    let now = f.e.ledger().timestamp() * 1000;
    let r = try_push(
        &f,
        payload(&[
            package(&key(1), &[("TSLA", P420)], now),
            package(&key(1), &[("TSLA", P420)], now),
        ]),
    );
    assert_eq!(r, Err(Ok(Error::NotEnoughSigners)));
}

#[test]
fn the_median_is_taken_so_one_broken_feed_cannot_drag_it() {
    let f = setup(3);
    let now = f.e.ledger().timestamp() * 1000;
    push(
        &f,
        payload(&[
            package(&key(1), &[("TSLA", P420)], now),
            package(&key(2), &[("TSLA", P420 + 100_000_000)], now),
            // One signer is wildly off. A mean would land near 600; a median
            // does not move past the honest pair.
            package(&key(3), &[("TSLA", P420 * 3)], now),
        ]),
    );
    assert_eq!(f.c.lastprice(&f.tsla).unwrap().price, 4_210_000_000);
}

#[test]
fn a_flipped_bit_changes_the_signer_and_falls_off_the_list() {
    let f = setup(2);
    let now = f.e.ledger().timestamp() * 1000;
    let mut p1 = package(&key(1), &[("TSLA", P420)], now);
    let p2 = package(&key(2), &[("TSLA", P420)], now);
    // Move the price by one unit without touching the signature. Recovery
    // still succeeds; it just returns somebody else.
    let last_value_byte = 32 + 31;
    p1[last_value_byte] ^= 0x01;

    let r = try_push(&f, payload(&[p1, p2]));
    assert_eq!(r, Err(Ok(Error::NotEnoughSigners)));
}

#[test]
fn a_replayed_report_is_refused() {
    let f = setup(2);
    let now = f.e.ledger().timestamp() * 1000;
    let bytes = payload(&[
        package(&key(1), &[("TSLA", P420)], now),
        package(&key(2), &[("TSLA", P420)], now),
    ]);
    push(&f, bytes.clone());
    assert_eq!(try_push(&f, bytes), Err(Ok(Error::NotNewer)));
}

#[test]
fn a_true_report_from_last_week_is_still_refused() {
    let f = setup(2);
    let old = (f.e.ledger().timestamp() - MAX_AGE - 1) * 1000;
    let r = try_push(
        &f,
        payload(&[
            package(&key(1), &[("TSLA", P420)], old),
            package(&key(2), &[("TSLA", P420)], old),
        ]),
    );
    assert_eq!(r, Err(Ok(Error::Stale)));
}

#[test]
fn a_price_walks_to_a_jump_instead_of_taking_it() {
    let f = setup(2);
    let t0 = f.e.ledger().timestamp() * 1000;
    push(
        &f,
        payload(&[
            package(&key(1), &[("TSLA", P420)], t0),
            package(&key(2), &[("TSLA", P420)], t0),
        ]),
    );
    assert_eq!(f.c.lastprice(&f.tsla).unwrap().price, 4_200_000_000);

    // A report at ten times the price. 1500 bps is all it may move.
    f.e.ledger().set_timestamp(f.e.ledger().timestamp() + 60);
    let t1 = f.e.ledger().timestamp() * 1000;
    push(
        &f,
        payload(&[
            package(&key(1), &[("TSLA", P420 * 10)], t1),
            package(&key(2), &[("TSLA", P420 * 10)], t1),
        ]),
    );
    assert_eq!(f.c.lastprice(&f.tsla).unwrap().price, 4_200_000_000 * 11500 / 10000);
}

#[test]
fn a_feed_nobody_registered_is_not_a_price() {
    let f = setup(2);
    let now = f.e.ledger().timestamp() * 1000;
    let r = try_push(
        &f,
        payload(&[
            package(&key(1), &[("DOGE", P420)], now),
            package(&key(2), &[("DOGE", P420)], now),
        ]),
    );
    assert_eq!(r, Err(Ok(Error::NoKnownFeed)));
}

#[test]
fn bytes_that_are_not_a_payload_are_refused_before_anything_else() {
    let f = setup(2);
    assert_eq!(
        try_push(&f, std::vec![0u8; 64]),
        Err(Ok(Error::NotRedStone))
    );
}

#[test]
fn one_package_can_carry_several_feeds() {
    let f = setup(2);
    let nvda = Asset::Other(Symbol::new(&f.e, "NVDA"));
    f.c.add_feed(&nvda, &BytesN::from_array(&f.e, &feed_id("NVDA")));

    let now = f.e.ledger().timestamp() * 1000;
    let points: &[(&str, i128)] = &[("TSLA", P420), ("NVDA", P420 * 2)];
    let n = push(&f, payload(&[package(&key(1), points, now), package(&key(2), points, now)]));

    assert_eq!(n, 2);
    assert_eq!(f.c.lastprice(&f.tsla).unwrap().price, 4_200_000_000);
    assert_eq!(f.c.lastprice(&nvda).unwrap().price, 8_400_000_000);
}

#[test]
fn the_sep40_surface_is_what_a_pool_expects() {
    let f = setup(2);
    assert_eq!(f.c.base(), Asset::Other(Symbol::new(&f.e, "USD")));
    assert_eq!(f.c.decimals(), 7);
    assert_eq!(f.c.resolution(), MAX_AGE as u32);
    assert_eq!(f.c.assets(), vec![&f.e, f.tsla.clone()]);
    assert_eq!(f.c.lastprice(&f.tsla), None);

    let now = f.e.ledger().timestamp() * 1000;
    push(
        &f,
        payload(&[
            package(&key(1), &[("TSLA", P420)], now),
            package(&key(2), &[("TSLA", P420)], now),
        ]),
    );
    let p = f.c.lastprice(&f.tsla).unwrap();
    assert_eq!(f.c.price(&f.tsla, &p.timestamp), Some(p.clone()));
    assert_eq!(f.c.price(&f.tsla, &(p.timestamp - 1)), None);
    assert_eq!(f.c.prices(&f.tsla, &1), Some(vec![&f.e, p]));
    assert_eq!(f.c.prices(&f.tsla, &0), None);
}

#[test]
fn the_admin_path_is_bounded_like_the_verified_one() {
    let f = setup(2);
    let now = f.e.ledger().timestamp() * 1000;
    push(
        &f,
        payload(&[
            package(&key(1), &[("TSLA", P420)], now),
            package(&key(2), &[("TSLA", P420)], now),
        ]),
    );
    f.e.ledger().set_timestamp(f.e.ledger().timestamp() + 60);
    f.c.set_price(&f.tsla, &1);
    // Down by the bound, not to one stroop.
    assert_eq!(f.c.lastprice(&f.tsla).unwrap().price, 4_200_000_000 * 8500 / 10000);
}

#[test]
fn a_feed_can_be_moved_and_the_old_one_stops_counting() {
    let f = setup(3);
    let old = BytesN::from_array(&f.e, &feed_id("SPY"));
    let new = BytesN::from_array(&f.e, &feed_id("SPY---PRE_AFTER"));
    let spy = Asset::Other(Symbol::new(&f.e, "SPY"));
    f.c.add_feed(&spy, &old);

    f.c.retarget_feed(&spy, &new);
    assert_eq!(f.c.feed(&spy), Some(new));

    // A report carrying the old ticker no longer finds this asset. Without
    // unbinding it, a feed deliberately moved away from could keep writing.
    let stale = payload(&[
        package(&key(1), &[("SPY", 100_0000000)], 1_700_000_000_000),
        package(&key(2), &[("SPY", 100_0000000)], 1_700_000_000_000),
        package(&key(3), &[("SPY", 100_0000000)], 1_700_000_000_000),
    ]);
    assert_eq!(
        f.c.try_push(&Bytes::from_slice(&f.e, &stale)),
        Err(Ok(Error::NoKnownFeed))
    );

    // And the new one does.
    let good = payload(&[
        // Eight decimals in the payload, seven out of the oracle: RedStone
        // signs 76_130_000_000 for $761.30 and the contract rescales.
        package(&key(1), &[("SPY---PRE_AFTER", 76_130_000_000)], 1_700_000_000_000),
        package(&key(2), &[("SPY---PRE_AFTER", 76_130_000_000)], 1_700_000_000_000),
        package(&key(3), &[("SPY---PRE_AFTER", 76_130_000_000)], 1_700_000_000_000),
    ]);
    f.c.push(&Bytes::from_slice(&f.e, &good));
    assert_eq!(f.c.lastprice(&spy).unwrap().price, 761_3000000);
}

#[test]
fn retargeting_refuses_a_feed_another_asset_already_owns() {
    let f = setup(3);
    let nvda = Asset::Other(Symbol::new(&f.e, "NVDA"));
    f.c.add_feed(&nvda, &BytesN::from_array(&f.e, &feed_id("NVDA")));
    assert_eq!(
        f.c.try_retarget_feed(&nvda, &BytesN::from_array(&f.e, &feed_id("TSLA"))),
        Err(Ok(Error::AlreadyRegistered))
    );
    assert_eq!(f.c.feed(&nvda), Some(BytesN::from_array(&f.e, &feed_id("NVDA"))));
}

#[test]
fn retargeting_an_unknown_asset_says_so() {
    let f = setup(3);
    let what = Asset::Other(Symbol::new(&f.e, "WHAT"));
    assert_eq!(
        f.c.try_retarget_feed(&what, &BytesN::from_array(&f.e, &feed_id("TSLA"))),
        Err(Ok(Error::UnknownAsset))
    );
}

#[test]
fn retargeting_to_the_same_feed_changes_nothing() {
    let f = setup(3);
    let id = BytesN::from_array(&f.e, &feed_id("TSLA"));
    f.c.retarget_feed(&f.tsla, &id);
    assert_eq!(f.c.feed(&f.tsla), Some(id));
}
