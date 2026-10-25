#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};

struct F {
    e: Env,
    v: VaultClient<'static>,
    usdc: Address,
    admin: Address,
    user: Address,
}

fn setup() -> F {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().set_timestamp(1_700_000_000);
    let admin = Address::generate(&e);
    let user = Address::generate(&e);
    let sac = e.register_stellar_asset_contract_v2(admin.clone());
    let usdc = sac.address();
    token::StellarAssetClient::new(&e, &usdc).mint(&user, &1_000_0000000);
    token::StellarAssetClient::new(&e, &usdc).mint(&admin, &1_000_0000000);
    let id = e.register(Vault, (admin.clone(), usdc.clone()));
    F { v: VaultClient::new(&e, &id), usdc, admin, user, e }
}

#[test]
fn an_empty_vault_is_one_to_one() {
    let f = setup();
    assert_eq!(f.v.rate(), RATE_SCALAR);
    assert_eq!(f.v.total_assets(), 0);
    assert_eq!(f.v.total_shares(), 0);
}

#[test]
fn a_deposit_lands_now() {
    let f = setup();
    let shares = f.v.deposit(&f.user, &100_0000000);
    assert_eq!(shares, 100_0000000);
    assert_eq!(f.v.shares(&f.user), 100_0000000);
    assert_eq!(f.v.assets_of(&f.user), 100_0000000);
    // The dollars actually moved.
    assert_eq!(token::Client::new(&f.e, &f.usdc).balance(&f.v.address), 100_0000000);
}

#[test]
fn a_withdrawal_pays_nothing_and_returns_a_ticket() {
    let f = setup();
    f.v.deposit(&f.user, &100_0000000);
    let before = token::Client::new(&f.e, &f.usdc).balance(&f.user);

    let id = f.v.request_withdrawal(&f.user, &40_0000000);
    assert_eq!(id, 1);
    // Not one dollar moved. This is the property the core's buffer exists for.
    assert_eq!(token::Client::new(&f.e, &f.usdc).balance(&f.user), before);
    assert_eq!(f.v.open_queue().len(), 1);

    let q = f.v.queued(&id).unwrap();
    assert_eq!(q.owner, f.user);
    assert_eq!(q.assets, 40_0000000);
    assert!(!q.paid);
    // The shares left at the moment of asking, so nothing earns on the way out.
    assert_eq!(f.v.shares(&f.user), 60_0000000);
}

#[test]
fn settling_pays_the_ticket_once() {
    let f = setup();
    f.v.deposit(&f.user, &100_0000000);
    let id = f.v.request_withdrawal(&f.user, &40_0000000);
    let before = token::Client::new(&f.e, &f.usdc).balance(&f.user);

    assert_eq!(f.v.settle(&id), 40_0000000);
    assert_eq!(token::Client::new(&f.e, &f.usdc).balance(&f.user), before + 40_0000000);
    assert_eq!(f.v.open_queue().len(), 0);
    assert!(f.v.queued(&id).unwrap().paid);
    // And not twice.
    assert_eq!(f.v.try_settle(&id), Err(Ok(Error::NothingQueued)));
}

#[test]
fn yield_lifts_every_share_and_moves_nobody_s_count() {
    let f = setup();
    f.v.deposit(&f.user, &100_0000000);
    f.v.accrue(&10_0000000);

    assert_eq!(f.v.shares(&f.user), 100_0000000);
    assert_eq!(f.v.assets_of(&f.user), 110_0000000);
    assert_eq!(f.v.rate(), 1_100_000_000_000);
}

#[test]
fn a_later_deposit_buys_fewer_shares_at_a_higher_rate() {
    let f = setup();
    f.v.deposit(&f.user, &100_0000000);
    f.v.accrue(&100_0000000); // the rate is now two
    let other = Address::generate(&f.e);
    token::StellarAssetClient::new(&f.e, &f.usdc).mint(&other, &100_0000000);

    let shares = f.v.deposit(&other, &100_0000000);
    assert_eq!(shares, 50_0000000);
    assert_eq!(f.v.assets_of(&other), 100_0000000);
    // And the first depositor keeps the whole gain.
    assert_eq!(f.v.assets_of(&f.user), 200_0000000);
}

#[test]
fn nothing_happens_on_a_zero_or_more_than_is_held() {
    let f = setup();
    f.v.deposit(&f.user, &100_0000000);
    assert_eq!(f.v.try_deposit(&f.user, &0), Err(Ok(Error::BadAmount)));
    assert_eq!(f.v.try_request_withdrawal(&f.user, &-1), Err(Ok(Error::BadAmount)));
    assert_eq!(
        f.v.try_request_withdrawal(&f.user, &200_0000000),
        Err(Ok(Error::NotEnoughShares))
    );
    assert_eq!(f.v.try_settle(&99), Err(Ok(Error::NothingQueued)));
}

#[test]
fn a_ticket_cannot_be_paid_out_of_money_that_is_not_there() {
    let f = setup();
    f.v.deposit(&f.user, &100_0000000);
    let id = f.v.request_withdrawal(&f.user, &100_0000000);
    // Simulate the cash being deployed: the admin claws it out.
    token::Client::new(&f.e, &f.usdc).transfer(&f.v.address, &f.admin, &100_0000000);
    assert_eq!(f.v.try_settle(&id), Err(Ok(Error::NotEnoughCash)));
}

#[test]
fn two_tickets_are_two_tickets() {
    let f = setup();
    f.v.deposit(&f.user, &100_0000000);
    let a = f.v.request_withdrawal(&f.user, &10_0000000);
    let b = f.v.request_withdrawal(&f.user, &20_0000000);
    assert_eq!((a, b), (1, 2));
    assert_eq!(f.v.open_queue().len(), 2);
    f.v.settle(&a);
    assert_eq!(f.v.open_queue(), Vec::from_array(&f.e, [b]));
}
