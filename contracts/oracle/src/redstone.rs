//! Reading a RedStone payload, and proving who signed it.
//!
//! RedStone does not run a chain. It signs price packages off chain and lets
//! anyone carry them, so the question a consumer has to answer is never "do I
//! trust the sender" but "who signed this, and do enough of them agree". That
//! is what this module answers, on chain, out of two host functions Soroban
//! already has: keccak256 and secp256k1_recover.
//!
//! The payload is read from its END, which is how RedStone built it so that it
//! could be appended to an EVM calldata and found again without a length
//! prefix. The layout, byte for byte:
//!
//! ```text
//! payload = [package_1 .. package_N][package count 2][metadata][metadata size 3][marker 9]
//! package = [point_1 .. point_M][timestamp 6][value size 4][point count 3][signature 65]
//! point   = [feed id 32][value, `value size` bytes, big endian]
//! ```
//!
//! The signed bytes are the package minus its 65 bytes of signature. A
//! signature is r, s and the recovery byte, 27 or 28 as Ethereum writes it.
//! The signer's identity is an Ethereum address: the last 20 bytes of the
//! keccak256 of the uncompressed public key without its 0x04 prefix.

use soroban_sdk::{contracttype, Bytes, BytesN, Env, Vec};

/// `0x000002ed57011e0000`, the nine bytes that say a payload is RedStone's.
const MARKER: [u8; 9] = [0x00, 0x00, 0x02, 0xed, 0x57, 0x01, 0x1e, 0x00, 0x00];

const SIG_BS: u32 = 65;
const POINT_COUNT_BS: u32 = 3;
const VALUE_SIZE_BS: u32 = 4;
const TIMESTAMP_BS: u32 = 6;
const FEED_ID_BS: u32 = 32;
const METADATA_SIZE_BS: u32 = 3;
const PACKAGE_COUNT_BS: u32 = 2;

/// One (feed, value) as one signer stated it. The signer travels with the value
/// because the aggregation rule is about distinct signers, not about values.
///
/// `#[contracttype]` is not for a caller's benefit, nothing returns a Quote: a
/// soroban Vec only holds what converts to a host value, and this is the cheap
/// way to say so.
#[contracttype]
#[derive(Clone)]
pub struct Quote {
    pub feed: BytesN<32>,
    pub value: i128,
    pub signer: BytesN<20>,
    /// Seconds, as RedStone writes it in milliseconds divided down.
    pub timestamp: u64,
}

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ParseError {
    NotRedStone,
    Truncated,
    NoPackages,
    ValueTooWide,
    BadRecoveryId,
}

/// Big endian unsigned integer out of `len` bytes. `len` is at most 8 here;
/// anything wider is a value, and values go through `read_value`.
fn read_uint(b: &Bytes, at: u32, len: u32) -> Result<u64, ParseError> {
    if at + len > b.len() {
        return Err(ParseError::Truncated);
    }
    let mut n: u64 = 0;
    for i in 0..len {
        n = (n << 8) | b.get(at + i).ok_or(ParseError::Truncated)? as u64;
    }
    Ok(n)
}

/// A RedStone numeric value: big endian, usually 32 bytes, almost always with
/// 24 leading zeros. We refuse anything that does not fit an i128 rather than
/// wrapping it, because a wrapped price is a price.
fn read_value(b: &Bytes, at: u32, len: u32) -> Result<i128, ParseError> {
    if at + len > b.len() {
        return Err(ParseError::Truncated);
    }
    let mut n: i128 = 0;
    for i in 0..len {
        let byte = b.get(at + i).ok_or(ParseError::Truncated)? as i128;
        if byte != 0 && (len - i) > 16 {
            return Err(ParseError::ValueTooWide);
        }
        n = n.checked_mul(256).ok_or(ParseError::ValueTooWide)?;
        n = n.checked_add(byte).ok_or(ParseError::ValueTooWide)?;
    }
    Ok(n)
}

/// The Ethereum address of whoever produced this signature over these bytes.
///
/// Recovery cannot fail in a way that returns no key: a wrong signature returns
/// the wrong signer, and the wrong signer is not on the list. That is the whole
/// check, and it is why the list is the only trusted input here.
fn recover(e: &Env, signed: &Bytes, sig: &Bytes) -> Result<BytesN<20>, ParseError> {
    let digest = e.crypto().keccak256(signed);

    let mut rs = [0u8; 64];
    for i in 0..64u32 {
        rs[i as usize] = sig.get(i).ok_or(ParseError::Truncated)?;
    }
    let v = sig.get(64).ok_or(ParseError::Truncated)?;
    let recovery_id: u32 = match v {
        27 | 28 => (v - 27) as u32,
        0 | 1 => v as u32,
        _ => return Err(ParseError::BadRecoveryId),
    };

    let key = e
        .crypto()
        .secp256k1_recover(&digest, &BytesN::from_array(e, &rs), recovery_id);

    // SEC-1 uncompressed: 0x04 then X then Y. Ethereum hashes the 64 bytes
    // after the prefix and keeps the last 20.
    let key_bytes: Bytes = key.into();
    let hashed = e.crypto().keccak256(&key_bytes.slice(1..65));
    let h: Bytes = hashed.to_bytes().into();
    let mut addr = [0u8; 20];
    for i in 0..20u32 {
        addr[i as usize] = h.get(12 + i).ok_or(ParseError::Truncated)?;
    }
    Ok(BytesN::from_array(e, &addr))
}

/// Every (feed, value, signer) the payload carries, with nothing filtered.
///
/// Whether a signer is allowed and whether enough of them agree is not decided
/// here: this function says what the bytes say and who signed them, and the
/// contract decides what that is worth.
pub fn parse(e: &Env, payload: &Bytes) -> Result<Vec<Quote>, ParseError> {
    let len = payload.len();
    if len < MARKER.len() as u32 + METADATA_SIZE_BS + PACKAGE_COUNT_BS {
        return Err(ParseError::Truncated);
    }

    // The marker first: it costs nine comparisons and it means every later
    // offset is read out of something that claims to be a payload.
    for (i, want) in MARKER.iter().enumerate() {
        let at = len - MARKER.len() as u32 + i as u32;
        if payload.get(at).ok_or(ParseError::Truncated)? != *want {
            return Err(ParseError::NotRedStone);
        }
    }

    let meta_size = read_uint(
        payload,
        len - MARKER.len() as u32 - METADATA_SIZE_BS,
        METADATA_SIZE_BS,
    )? as u32;
    let mut back = MARKER.len() as u32 + METADATA_SIZE_BS + meta_size;

    if back + PACKAGE_COUNT_BS > len {
        return Err(ParseError::Truncated);
    }
    let packages = read_uint(payload, len - back - PACKAGE_COUNT_BS, PACKAGE_COUNT_BS)? as u32;
    back += PACKAGE_COUNT_BS;
    if packages == 0 {
        return Err(ParseError::NoPackages);
    }

    let mut out = Vec::new(e);
    for _ in 0..packages {
        if back > len {
            return Err(ParseError::Truncated);
        }
        let end = len - back;
        if end < SIG_BS + POINT_COUNT_BS + VALUE_SIZE_BS + TIMESTAMP_BS {
            return Err(ParseError::Truncated);
        }

        let sig_at = end - SIG_BS;
        let count_at = sig_at - POINT_COUNT_BS;
        let size_at = count_at - VALUE_SIZE_BS;
        let ts_at = size_at - TIMESTAMP_BS;

        let point_count = read_uint(payload, count_at, POINT_COUNT_BS)? as u32;
        let value_size = read_uint(payload, size_at, VALUE_SIZE_BS)? as u32;
        if value_size == 0 || value_size > 32 {
            return Err(ParseError::ValueTooWide);
        }
        // RedStone writes milliseconds. Seconds are what a ledger compares to.
        let timestamp = read_uint(payload, ts_at, TIMESTAMP_BS)? / 1000;

        let points_bs = point_count
            .checked_mul(FEED_ID_BS + value_size)
            .ok_or(ParseError::Truncated)?;
        if points_bs > ts_at {
            return Err(ParseError::Truncated);
        }
        let start = ts_at - points_bs;

        let signer = recover(e, &payload.slice(start..sig_at), &payload.slice(sig_at..end))?;

        for i in 0..point_count {
            let at = start + i * (FEED_ID_BS + value_size);
            let feed: BytesN<32> = payload.slice(at..at + FEED_ID_BS).try_into().unwrap();
            let value = read_value(payload, at + FEED_ID_BS, value_size)?;
            out.push_back(Quote { feed, value, signer: signer.clone(), timestamp });
        }

        back += end - start;
    }

    Ok(out)
}
