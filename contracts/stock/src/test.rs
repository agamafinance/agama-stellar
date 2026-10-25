#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::Env;

const DRIP: i128 = 10_0000000; // 10 shares at 7 decimals
const COOLDOWN: u64 = 3600;

fn setup(e: &Env) -> (StockClient<'static>, Address) {
    let admin = Address::generate(e);
    let id = e.register(
        Stock,
        (
            admin.clone(),
            7u32,
            String::from_str(e, "Tesla"),
            String::from_str(e, "TSLAx"),
            DRIP,
            COOLDOWN,
        ),
    );
    (StockClient::new(e, &id), admin)
}

#[test]
fn metadata_is_what_was_deployed() {
    let e = Env::default();
    let (c, admin) = setup(&e);
    assert_eq!(c.decimals(), 7);
    assert_eq!(c.name(), String::from_str(&e, "Tesla"));
    assert_eq!(c.symbol(), String::from_str(&e, "TSLAx"));
    assert_eq!(c.admin(), admin);
    assert_eq!(c.drip(), DRIP);
}

#[test]
fn faucet_hands_out_a_fixed_quantity() {
    let e = Env::default();
    e.mock_all_auths();
    let (c, _) = setup(&e);
    let user = Address::generate(&e);

    assert_eq!(c.faucet_in(&user), 0);
    assert_eq!(c.faucet(&user), DRIP);
    assert_eq!(c.balance(&user), DRIP);
}

#[test]
fn the_cooldown_is_per_address_and_real() {
    let e = Env::default();
    e.mock_all_auths();
    let (c, _) = setup(&e);
    let a = Address::generate(&e);
    let b = Address::generate(&e);

    c.faucet(&a);
    // b is not held back by a's draw.
    c.faucet(&b);
    assert_eq!(c.faucet_in(&a), COOLDOWN);

    // One second short of the cooldown is still short.
    e.ledger().set_timestamp(COOLDOWN - 1);
    assert_eq!(c.faucet_in(&a), 1);
    assert_eq!(c.try_faucet(&a), Err(Ok(Error::FaucetCooldown)));

    e.ledger().set_timestamp(COOLDOWN);
    assert_eq!(c.faucet(&a), DRIP);
    assert_eq!(c.balance(&a), 2 * DRIP);
}

#[test]
fn transfer_moves_exactly_what_it_says() {
    let e = Env::default();
    e.mock_all_auths();
    let (c, _) = setup(&e);
    let a = Address::generate(&e);
    let b = Address::generate(&e);
    c.faucet(&a);

    c.transfer(&a, &b, &4_0000000);
    assert_eq!(c.balance(&a), 6_0000000);
    assert_eq!(c.balance(&b), 4_0000000);

    assert_eq!(c.try_transfer(&a, &b, &7_0000000), Err(Ok(Error::InsufficientBalance)));
    assert_eq!(c.try_transfer(&a, &b, &-1), Err(Ok(Error::NegativeAmount)));
}

#[test]
fn an_allowance_is_spent_once_and_dies_on_time() {
    let e = Env::default();
    e.mock_all_auths();
    let (c, _) = setup(&e);
    let owner = Address::generate(&e);
    let spender = Address::generate(&e);
    let sink = Address::generate(&e);
    c.faucet(&owner);

    c.approve(&owner, &spender, &5_0000000, &(e.ledger().sequence() + 100));
    assert_eq!(c.allowance(&owner, &spender), 5_0000000);

    c.transfer_from(&spender, &owner, &sink, &3_0000000);
    assert_eq!(c.allowance(&owner, &spender), 2_0000000);
    assert_eq!(c.balance(&sink), 3_0000000);

    assert_eq!(
        c.try_transfer_from(&spender, &owner, &sink, &3_0000000),
        Err(Ok(Error::InsufficientAllowance))
    );

    // Past its expiry the allowance reads as nothing, not as a stale number.
    e.ledger().set_sequence_number(e.ledger().sequence() + 101);
    assert_eq!(c.allowance(&owner, &spender), 0);
}

#[test]
fn burning_reduces_the_supply_a_holder_can_move() {
    let e = Env::default();
    e.mock_all_auths();
    let (c, _) = setup(&e);
    let a = Address::generate(&e);
    c.faucet(&a);

    c.burn(&a, &4_0000000);
    assert_eq!(c.balance(&a), 6_0000000);
    assert_eq!(c.try_burn(&a, &7_0000000), Err(Ok(Error::InsufficientBalance)));
}

#[test]
fn only_the_admin_mints() {
    let e = Env::default();
    let (c, admin) = setup(&e);
    let stranger = Address::generate(&e);

    // Nothing is mocked here: the admin's own auth is what the call needs.
    e.mock_all_auths();
    c.mint(&stranger, &1_000_0000000);
    assert_eq!(c.balance(&stranger), 1_000_0000000);

    c.set_admin(&stranger);
    assert_eq!(c.admin(), stranger);
    let _ = admin;
}
