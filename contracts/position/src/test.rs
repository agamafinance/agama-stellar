#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, AuthorizedFunction, AuthorizedInvocation, Ledger};
use soroban_sdk::symbol_short;

/// A pool that records what it was told and answers like Blend does.
///
/// The point of testing against this rather than the real wasm is what it lets
/// us assert: that the position sends exactly four kinds of request, with the
/// asset and the amount the core named, and that it converts b_tokens and
/// d_tokens back through the reserve rates instead of reporting them raw.
mod mock_pool {
    use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Map, Vec};

    #[contracttype]
    #[derive(Clone)]
    pub struct Request {
        pub address: Address,
        pub amount: i128,
        pub request_type: u32,
    }
    #[contracttype]
    #[derive(Clone)]
    pub struct Positions {
        pub collateral: Map<u32, i128>,
        pub liabilities: Map<u32, i128>,
        pub supply: Map<u32, i128>,
    }
    #[contracttype]
    #[derive(Clone)]
    pub struct ReserveData {
        pub b_rate: i128,
        pub b_supply: i128,
        pub backstop_credit: i128,
        pub d_rate: i128,
        pub d_supply: i128,
        pub ir_mod: i128,
        pub last_time: u64,
    }
    /// The field names are Blend's, because a soroban struct travels as a map
    /// keyed by them: a mock whose `config` is a u32 where theirs is a struct
    /// does not fail at the call, it fails when the client tries to read the
    /// answer back, which is a far worse place to learn it.
    #[contracttype]
    #[derive(Clone)]
    pub struct ReserveConfig {
        pub c_factor: u32,
        pub decimals: u32,
        pub enabled: bool,
        pub index: u32,
        pub l_factor: u32,
        pub max_util: u32,
        pub r_base: u32,
        pub r_one: u32,
        pub r_three: u32,
        pub r_two: u32,
        pub reactivity: u32,
        pub supply_cap: i128,
        pub util: u32,
    }
    #[contracttype]
    #[derive(Clone)]
    pub struct Reserve {
        pub asset: Address,
        pub config: ReserveConfig,
        pub data: ReserveData,
        pub scalar: i128,
    }
    #[contracttype]
    enum K {
        Log,
        Pos,
        Rate(Address),
    }

    #[contract]
    pub struct MockPool;

    #[contractimpl]
    impl MockPool {
        pub fn seed(e: Env, asset: Address, b_rate: i128, d_rate: i128) {
            e.storage().instance().set(&K::Rate(asset), &(b_rate, d_rate));
        }
        pub fn put(e: Env, collateral: Map<u32, i128>, liabilities: Map<u32, i128>) {
            e.storage().instance().set(
                &K::Pos,
                &Positions { collateral, liabilities, supply: Map::new(&e) },
            );
        }
        pub fn log(e: Env) -> Vec<Request> {
            e.storage().instance().get(&K::Log).unwrap_or(Vec::new(&e))
        }
        pub fn submit(
            e: Env,
            from: Address,
            _spender: Address,
            _to: Address,
            requests: Vec<Request>,
        ) -> Positions {
            from.require_auth();
            let mut log: Vec<Request> = e.storage().instance().get(&K::Log).unwrap_or(Vec::new(&e));
            for r in requests.iter() {
                log.push_back(r);
            }
            e.storage().instance().set(&K::Log, &log);
            Self::get_positions(e, from)
        }
        pub fn get_positions(e: Env, _address: Address) -> Positions {
            e.storage().instance().get(&K::Pos).unwrap_or(Positions {
                collateral: Map::new(&e),
                liabilities: Map::new(&e),
                supply: Map::new(&e),
            })
        }
        pub fn get_reserve(e: Env, asset: Address) -> Reserve {
            let (b_rate, d_rate): (i128, i128) = e
                .storage()
                .instance()
                .get(&K::Rate(asset.clone()))
                .unwrap_or((1_000_000_000_000, 1_000_000_000_000));
            Reserve {
                asset,
                config: ReserveConfig {
                    c_factor: 7_000_000,
                    decimals: 7,
                    enabled: true,
                    index: 0,
                    l_factor: 8_000_000,
                    max_util: 9_500_000,
                    r_base: 100_000,
                    r_one: 500_000,
                    r_three: 15_000_000,
                    r_two: 5_000_000,
                    reactivity: 1_000,
                    supply_cap: i128::MAX,
                    util: 7_500_000,
                },
                data: ReserveData {
                    b_rate,
                    b_supply: 0,
                    backstop_credit: 0,
                    d_rate,
                    d_supply: 0,
                    ir_mod: 0,
                    last_time: 0,
                },
                scalar: 10_000_000,
            }
        }
    }
}

use mock_pool::{MockPool, MockPoolClient};

const STOCK_IX: u32 = 1;
const USDC_IX: u32 = 0;

struct F {
    e: Env,
    p: PositionClient<'static>,
    pool: MockPoolClient<'static>,
    core: Address,
    owner: Address,
    stock: Address,
    usdc: Address,
}

fn setup() -> F {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().set_timestamp(1_700_000_000);

    let core = Address::generate(&e);
    let owner = Address::generate(&e);
    let stock = e.register_stellar_asset_contract_v2(Address::generate(&e)).address();
    let usdc = e.register_stellar_asset_contract_v2(Address::generate(&e)).address();
    let pool_id = e.register(MockPool, ());

    let id = e.register(
        Position,
        (
            core.clone(),
            owner.clone(),
            stock.clone(),
            usdc.clone(),
            pool_id.clone(),
            STOCK_IX,
            USDC_IX,
            Product::Earn,
            7000u32,
        ),
    );
    F {
        p: PositionClient::new(&e, &id),
        pool: MockPoolClient::new(&e, &pool_id),
        core,
        owner,
        stock,
        usdc,
        e,
    }
}

#[test]
fn it_knows_what_it_is() {
    let f = setup();
    assert_eq!(f.p.owner(), f.owner);
    assert_eq!(f.p.core(), f.core);
    assert_eq!(f.p.stock(), f.stock);
    assert_eq!(f.p.product(), Product::Earn);
    assert_eq!(f.p.target(), 7000);
    assert_eq!(f.p.last_touch(), None);
}

#[test]
fn the_four_requests_are_the_ones_blend_expects() {
    let f = setup();
    f.p.supply(&100);
    f.p.borrow(&40, &f.p.address);
    f.p.repay(&10);
    f.p.unsupply(&5, &f.p.address);

    let log = f.pool.log();
    assert_eq!(log.len(), 4);
    let kinds: std::vec::Vec<(u32, i128)> =
        log.iter().map(|r| (r.request_type, r.amount)).collect();
    assert_eq!(kinds, std::vec![(2, 100), (4, 40), (5, 10), (3, 5)]);

    assert_eq!(log.get(0).unwrap().address, f.stock);
    assert_eq!(log.get(1).unwrap().address, f.usdc);
    assert_eq!(log.get(2).unwrap().address, f.usdc);
    assert_eq!(log.get(3).unwrap().address, f.stock);
}

#[test]
fn nothing_moves_on_a_zero_or_a_negative() {
    let f = setup();
    assert_eq!(f.p.try_supply(&0), Err(Ok(Error::BadAmount)));
    assert_eq!(f.p.try_borrow(&-1, &f.owner), Err(Ok(Error::BadAmount)));
    assert_eq!(f.p.try_repay(&0), Err(Ok(Error::BadAmount)));
    assert_eq!(f.p.try_unsupply(&-7, &f.owner), Err(Ok(Error::BadAmount)));
    assert_eq!(f.pool.log().len(), 0);
}

#[test]
fn only_the_core_may_move_anything() {
    let f = setup();
    // No mocking: the real auth tree is checked, and it requires the core.
    f.e.set_auths(&[]);
    assert!(f.p.try_supply(&100).is_err());
    assert!(f.p.try_set_target(&5000).is_err());
    assert!(f.p.try_touch(&f.owner, &symbol_short!("poke")).is_err());
}

#[test]
fn the_core_is_the_signature_blend_sees() {
    let f = setup();
    f.p.supply(&100);
    // The position is what authorised the pool call, not the core: Blend's
    // borrower of record is this contract.
    let auths = f.e.auths();
    assert_eq!(auths.get(0).map(|(a, _)| a.clone()), Some(f.core.clone()));
    if let Some((_, AuthorizedInvocation { function, .. })) = auths.into_iter().next() {
        match function {
            AuthorizedFunction::Contract((id, fname, _)) => {
                assert_eq!(id, f.p.address);
                assert_eq!(fname, symbol_short!("supply"));
            }
            _ => panic!("expected a contract call"),
        }
    }
}

#[test]
fn b_tokens_and_d_tokens_come_back_as_the_asset() {
    let f = setup();
    // A reserve that has accrued: a b_token is worth 1.25 of the asset, a
    // d_token 1.50. Reporting the raw token counts would understate both.
    f.pool.seed(&f.stock, &1_250_000_000_000, &1_000_000_000_000);
    f.pool.seed(&f.usdc, &1_000_000_000_000, &1_500_000_000_000);

    let mut collateral = soroban_sdk::Map::new(&f.e);
    collateral.set(STOCK_IX, 100_0000000);
    let mut liabilities = soroban_sdk::Map::new(&f.e);
    liabilities.set(USDC_IX, 40_0000000);
    f.pool.put(&collateral, &liabilities);

    assert_eq!(f.p.collateral(), 125_0000000);
    assert_eq!(f.p.debt(), 60_0000000);
}

#[test]
fn a_debt_is_rounded_up_so_nobody_else_pays_the_remainder() {
    let f = setup();
    // A rate that does not divide cleanly.
    f.pool.seed(&f.usdc, &1_000_000_000_000, &1_000_000_000_001);
    let mut liabilities = soroban_sdk::Map::new(&f.e);
    liabilities.set(USDC_IX, 1_0000000);
    f.pool.put(&soroban_sdk::Map::new(&f.e), &liabilities);

    // 10,000,000 * 1.000000000001 is 10,000,000.00001; a floor would say ten.
    assert_eq!(f.p.debt(), 1_0000001);
}

#[test]
fn an_empty_position_owes_nothing_and_holds_nothing() {
    let f = setup();
    assert_eq!(f.p.collateral(), 0);
    assert_eq!(f.p.debt(), 0);
}

#[test]
fn every_agent_pass_leaves_its_name_on_the_position() {
    let f = setup();
    let agent = Address::generate(&f.e);
    f.p.touch(&agent, &symbol_short!("rebal"));

    let t = f.p.last_touch().unwrap();
    assert_eq!(t.agent, agent);
    assert_eq!(t.action, symbol_short!("rebal"));
    assert_eq!(t.at, f.e.ledger().timestamp());

    f.e.ledger().set_timestamp(f.e.ledger().timestamp() + 60);
    let other = Address::generate(&f.e);
    f.p.touch(&other, &symbol_short!("compnd"));
    let t = f.p.last_touch().unwrap();
    assert_eq!(t.agent, other);
    assert_eq!(t.at, f.e.ledger().timestamp());
}

#[test]
fn borrowing_to_somewhere_else_sends_the_dollars_there() {
    let f = setup();
    let vault = Address::generate(&f.e);
    let sac = f.e.register_stellar_asset_contract_v2(f.core.clone());
    let usdc = sac.address();
    // Rebuild the position on a token we can mint, to watch the transfer.
    let id = f.e.register(
        Position,
        (
            f.core.clone(),
            f.owner.clone(),
            f.stock.clone(),
            usdc.clone(),
            f.pool.address.clone(),
            STOCK_IX,
            USDC_IX,
            Product::Earn,
            7000u32,
        ),
    );
    let p = PositionClient::new(&f.e, &id);
    soroban_sdk::token::StellarAssetClient::new(&f.e, &usdc).mint(&id, &50_0000000);

    p.borrow(&40_0000000, &vault);
    let t = token::Client::new(&f.e, &usdc);
    assert_eq!(t.balance(&vault), 40_0000000);
    assert_eq!(t.balance(&id), 10_0000000);
    let _ = f.usdc;
}
