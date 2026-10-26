#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{symbol_short, Bytes};

/// `core` has its own `mod oracle`, holding the client it talks through, so
/// inside the crate `oracle` is that module and not the contract. The real one
/// is addressed from the crate root.
use ::oracle as oracle_contract;

/// A pool that behaves like Blend for the four requests this protocol sends,
/// and keeps real balances so the core's arithmetic has something to be wrong
/// about. Rates are one to one: interest accrual is the position contract's
/// test, not this one.
mod mock_pool {
    use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Map, Vec};

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
        Index(Address),
        Pos(Address),
        DRate,
    }

    #[contract]
    pub struct MockPool;

    #[contractimpl]
    impl MockPool {
        pub fn register(e: Env, asset: Address, index: u32) {
            e.storage().instance().set(&K::Index(asset), &index);
        }

        /// Let a debt grow, the way one does between two ledgers. Blend
        /// carries interest in the reserve's d_rate rather than in the
        /// borrower's token count, and everything that reads a debt here
        /// multiplies by it.
        pub fn accrue(e: Env, d_rate: i128) {
            e.storage().instance().set(&K::DRate, &d_rate);
        }

        pub fn submit(
            e: Env,
            from: Address,
            _spender: Address,
            _to: Address,
            requests: Vec<Request>,
        ) -> Positions {
            from.require_auth();
            let mut p = Self::get_positions(e.clone(), from.clone());
            let me = e.current_contract_address();
            for r in requests.iter() {
                let ix: u32 = e.storage().instance().get(&K::Index(r.address.clone())).unwrap();
                let t = token::Client::new(&e, &r.address);
                match r.request_type {
                    2 => {
                        t.transfer(&from, &me, &r.amount);
                        p.collateral.set(ix, p.collateral.get(ix).unwrap_or(0) + r.amount);
                    }
                    3 => {
                        t.transfer(&me, &from, &r.amount);
                        p.collateral.set(ix, p.collateral.get(ix).unwrap_or(0) - r.amount);
                    }
                    4 => {
                        t.transfer(&me, &from, &r.amount);
                        p.liabilities.set(ix, p.liabilities.get(ix).unwrap_or(0) + r.amount);
                    }
                    5 => {
                        // Blend pulls exactly what the request named and
                        // refunds the excess (apply_repay: the spender
                        // transfer is request.amount, the pool transfer is
                        // the difference). That order matters here: the
                        // position authorises one amount for the pull, so a
                        // mock that quietly pulled less would fail the auth
                        // check rather than the repayment, and only when a
                        // debt had accrued past the repayment.
                        let owed = p.liabilities.get(ix).unwrap_or(0);
                        let paid = if r.amount > owed { owed } else { r.amount };
                        t.transfer(&from, &me, &r.amount);
                        if r.amount > paid {
                            t.transfer(&me, &from, &(r.amount - paid));
                        }
                        p.liabilities.set(ix, owed - paid);
                    }
                    _ => panic!("unexpected request type"),
                }
            }
            e.storage().instance().set(&K::Pos(from), &p);
            p
        }

        pub fn get_positions(e: Env, address: Address) -> Positions {
            e.storage().instance().get(&K::Pos(address)).unwrap_or(Positions {
                collateral: Map::new(&e),
                liabilities: Map::new(&e),
                supply: Map::new(&e),
            })
        }

        pub fn get_reserve(e: Env, asset: Address) -> Reserve {
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
                    b_rate: 1_000_000_000_000,
                    b_supply: 0,
                    backstop_credit: 0,
                    d_rate: e
                        .storage()
                        .instance()
                        .get(&K::DRate)
                        .unwrap_or(1_000_000_000_000),
                    d_supply: 0,
                    ir_mod: 0,
                    last_time: 0,
                },
                scalar: 10_000_000,
            }
        }
    }
}

/// The vault, reduced to what the core uses and to the thing that matters: a
/// deposit lands, a withdrawal is a request that does NOT pay out. If this
/// mock paid instantly, every test about the buffer would pass for the wrong
/// reason.
mod mock_vault {
    use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token, Address, Env};

    /// The real vault's codes, because a mock that cannot refuse is a mock
    /// that proves the chain will not: this one is #3 there too.
    #[contracterror]
    #[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
    #[repr(u32)]
    pub enum Error {
        NotEnoughShares = 3,
    }

    #[contracttype]
    enum K {
        Usdc,
        Deposited(Address),
        Queued(Address),
    }

    #[contract]
    pub struct MockVault;

    #[contractimpl]
    impl MockVault {
        pub fn __constructor(e: Env, usdc: Address) {
            e.storage().instance().set(&K::Usdc, &usdc);
        }
        pub fn deposit(e: Env, from: Address, amount: i128) -> i128 {
            from.require_auth();
            // A transfer, not a transfer_from, because that is what the real
            // vault does: it asks the depositor to authorise and then pulls.
            let usdc: Address = e.storage().instance().get(&K::Usdc).unwrap();
            token::Client::new(&e, &usdc).transfer(&from, &e.current_contract_address(), &amount);
            let d: i128 = e.storage().instance().get(&K::Deposited(from.clone())).unwrap_or(0);
            e.storage().instance().set(&K::Deposited(from), &(d + amount));
            amount
        }
        pub fn request_withdrawal(e: Env, from: Address, amount: i128) -> Result<u64, Error> {
            // The real vault burns shares to queue, so it refuses a request
            // for more than the depositor holds. Letting that through here is
            // how a close that cannot happen on chain passes in a test.
            if amount > Self::assets_of(e.clone(), from.clone()) {
                return Err(Error::NotEnoughShares);
            }
            let q: i128 = e.storage().instance().get(&K::Queued(from.clone())).unwrap_or(0);
            e.storage().instance().set(&K::Queued(from), &(q + amount));
            Ok(1)
        }
        /// What the depositor could still ask for.
        pub fn assets_of(e: Env, of: Address) -> i128 {
            let d: i128 = e.storage().instance().get(&K::Deposited(of.clone())).unwrap_or(0);
            let q: i128 = e.storage().instance().get(&K::Queued(of)).unwrap_or(0);
            d - q
        }
        pub fn deposited(e: Env, who: Address) -> i128 {
            e.storage().instance().get(&K::Deposited(who)).unwrap_or(0)
        }
        pub fn queued(e: Env, who: Address) -> i128 {
            e.storage().instance().get(&K::Queued(who)).unwrap_or(0)
        }
        /// What the FIFO does when it reaches the request, days later.
        pub fn settle(e: Env, who: Address) {
            let q: i128 = e.storage().instance().get(&K::Queued(who.clone())).unwrap_or(0);
            if q == 0 {
                return;
            }
            let usdc: Address = e.storage().instance().get(&K::Usdc).unwrap();
            token::Client::new(&e, &usdc).transfer(&e.current_contract_address(), &who, &q);
            e.storage().instance().set(&K::Queued(who), &0i128);
        }
    }
}

use mock_pool::{MockPool, MockPoolClient};
use mock_vault::{MockVault, MockVaultClient};

const USDC_IX: u32 = 0;
const STOCK_IX: u32 = 1;
const LTV: u32 = 7000;
const THRESHOLD: u32 = 8000;
const OFF_HOURS: u32 = 500;
const MAX_AGE: u64 = 3600;
/// 420 dollars a share, at seven decimals.
const PRICE: i128 = 420_0000000;

struct F {
    e: Env,
    c: CoreClient<'static>,
    pool: MockPoolClient<'static>,
    vault: MockVaultClient<'static>,
    oracle: oracle_contract::OracleClient<'static>,
    stock: stock::StockClient<'static>,
    usdc: soroban_sdk::token::StellarAssetClient<'static>,
    usdc_id: Address,
    admin: Address,
    user: Address,
    agent: Address,
}

fn setup() -> F {
    setup_with(500_000_0000000)
}

fn setup_with(buffer: i128) -> F {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().set_timestamp(1_700_000_000);

    let admin = Address::generate(&e);
    let user = Address::generate(&e);
    let agent = Address::generate(&e);

    let usdc_sac = e.register_stellar_asset_contract_v2(admin.clone());
    let usdc_id = usdc_sac.address();
    let usdc = soroban_sdk::token::StellarAssetClient::new(&e, &usdc_id);

    let stock_id = e.register(
        stock::Stock,
        (
            admin.clone(),
            7u32,
            String::from_str(&e, "Tesla"),
            String::from_str(&e, "TSLAx"),
            10_0000000i128,
            3600u64,
        ),
    );
    let stock = stock::StockClient::new(&e, &stock_id);

    let oracle_id = e.register(
        oracle_contract::Oracle,
        (
            admin.clone(),
            Vec::<BytesN<20>>::from_array(&e, [BytesN::from_array(&e, &[1u8; 20])]),
            1u32,
            7u32,
            MAX_AGE,
            10_000u32, // no bound in these tests: the oracle's own suite covers it
        ),
    );
    let oracle_c = oracle_contract::OracleClient::new(&e, &oracle_id);
    oracle_c.add_feed(
        &oracle_contract::Asset::Stellar(stock_id.clone()),
        &BytesN::from_array(&e, &[9u8; 32]),
    );
    oracle_c.set_price(&oracle_contract::Asset::Stellar(stock_id.clone()), &PRICE);

    let pool_id = e.register(MockPool, ());
    let pool = MockPoolClient::new(&e, &pool_id);
    pool.register(&usdc_id, &USDC_IX);
    pool.register(&stock_id, &STOCK_IX);

    let vault_id = e.register(MockVault, (usdc_id.clone(),));
    let vault = MockVaultClient::new(&e, &vault_id);

    let wasm = e
        .deployer()
        .upload_contract_wasm(Bytes::from_slice(&e, POSITION_WASM));

    let core_id = e.register(
        Core,
        (
            admin.clone(),
            usdc_id.clone(),
            USDC_IX,
            pool_id.clone(),
            oracle_id.clone(),
            vault_id.clone(),
            wasm,
            MAX_AGE,
        ),
    );
    let c = CoreClient::new(&e, &core_id);
    c.add_market(&stock_id, &STOCK_IX, &LTV, &THRESHOLD, &OFF_HOURS);

    // The pool has dollars to lend, the user has shares, the core has a buffer,
    // and the core is the stock's admin so the stand-in swap can mint.
    usdc.mint(&pool_id, &1_000_000_0000000);
    usdc.mint(&admin, &1_000_000_0000000);
    stock.mint(&user, &100_0000000);
    stock.set_admin(&core_id);
    c.fund_buffer(&admin, &buffer);

    F { c, pool, vault, oracle: oracle_c, stock, usdc, usdc_id, admin, user, agent, e }
}

static POSITION_WASM: &[u8] =
    include_bytes!("../../../target/wasm32v1-none/release/position.wasm");

fn pos_client<'a>(f: &F, id: &Address) -> position::Client<'a> {
    position::Client::new(&f.e, id)
}

#[test]
fn a_deposit_borrows_to_the_target_and_the_dollars_reach_the_vault() {
    let f = setup();
    let id = f.c.earn_deposit(&f.user, &f.stock.address, &10_0000000, &LTV);
    let p = pos_client(&f, &id);

    // Ten shares at 420 is 4,200 of collateral; 70% of that is 2,940 borrowed.
    assert_eq!(p.collateral(), 10_0000000);
    assert_eq!(p.debt(), 2_940_0000000);
    assert_eq!(f.vault.deposited(&id), 2_940_0000000);
    // Nothing is left loose in the position: borrow and deposit are one step.
    assert_eq!(token::Client::new(&f.e, &f.usdc_id).balance(&id), 0);

    let h = f.c.health(&id);
    assert_eq!(h.collateral, 4_200_0000000);
    assert_eq!(h.ltv, LTV);
    assert_eq!(h.max_ltv, LTV);
}

#[test]
fn the_position_address_is_the_same_one_every_time() {
    let f = setup();
    let a = f.c.earn_deposit(&f.user, &f.stock.address, &5_0000000, &LTV);
    let b = f.c.earn_deposit(&f.user, &f.stock.address, &5_0000000, &LTV);
    assert_eq!(a, b);
    assert_eq!(f.c.position_of(&f.user, &f.stock.address, &Product::Earn), Some(a.clone()));
    assert_eq!(f.c.positions().len(), 1);
    assert_eq!(pos_client(&f, &a).collateral(), 10_0000000);
}

#[test]
fn earn_and_amplify_are_two_positions_for_one_owner() {
    let f = setup();
    let earn = f.c.earn_deposit(&f.user, &f.stock.address, &5_0000000, &LTV);
    let amp = f.c.amplify_open(&f.user, &f.stock.address, &5_0000000, &20_000);
    assert_ne!(earn, amp);
    assert_eq!(f.c.positions().len(), 2);
}

#[test]
fn a_target_above_what_the_market_allows_is_refused() {
    let f = setup();
    assert_eq!(
        f.c.try_earn_deposit(&f.user, &f.stock.address, &10_0000000, &(LTV + 1)),
        Err(Ok(Error::BadTarget))
    );
    assert_eq!(
        f.c.try_earn_deposit(&f.user, &f.stock.address, &10_0000000, &0),
        Err(Ok(Error::BadTarget))
    );
}

#[test]
fn off_hours_tightens_both_numbers_by_the_same_buffer() {
    let f = setup();
    f.c.set_session(&f.stock.address, &true);

    // The old ceiling is no longer reachable.
    assert_eq!(
        f.c.try_earn_deposit(&f.user, &f.stock.address, &10_0000000, &LTV),
        Err(Ok(Error::BadTarget))
    );
    let id = f.c.earn_deposit(&f.user, &f.stock.address, &10_0000000, &(LTV - OFF_HOURS));
    let h = f.c.health(&id);
    assert_eq!(h.max_ltv, LTV - OFF_HOURS);
    assert_eq!(h.threshold, THRESHOLD - OFF_HOURS);
}

#[test]
fn a_price_that_went_stale_stops_a_borrow() {
    let f = setup();
    f.e.ledger().set_timestamp(f.e.ledger().timestamp() + MAX_AGE + 1);
    assert_eq!(
        f.c.try_earn_deposit(&f.user, &f.stock.address, &10_0000000, &LTV),
        Err(Ok(Error::StalePrice))
    );
}

#[test]
fn a_rise_is_borrowed_into_the_vault_by_whoever_runs_the_agent() {
    let f = setup();
    let id = f.c.earn_deposit(&f.user, &f.stock.address, &10_0000000, &LTV);
    let before = pos_client(&f, &id).debt();

    // Up ten percent.
    f.oracle
        .set_price(&oracle_contract::Asset::Stellar(f.stock.address.clone()), &(PRICE * 11 / 10));
    let delta = f.c.rebalance(&f.agent, &id);

    assert!(delta > 0);
    assert_eq!(pos_client(&f, &id).debt(), before + delta);
    assert_eq!(f.vault.deposited(&id), before + delta);
    // The agent left its name, which is what the card reads.
    let t = pos_client(&f, &id).last_touch().unwrap();
    assert_eq!(t.agent, f.agent);
    assert_eq!(t.action, symbol_short!("rebal"));
}

#[test]
fn a_fall_is_repaid_out_of_the_buffer_now_and_the_queue_refills_it_later() {
    let f = setup();
    let id = f.c.earn_deposit(&f.user, &f.stock.address, &10_0000000, &LTV);
    let debt_before = pos_client(&f, &id).debt();
    let buffer_before = f.c.buffer();

    // Down ten percent. The vault cannot pay out; the buffer must.
    f.oracle
        .set_price(&oracle_contract::Asset::Stellar(f.stock.address.clone()), &(PRICE * 9 / 10));
    let delta = f.c.rebalance(&f.agent, &id);
    assert!(delta < 0);

    let repaid = -delta;
    assert_eq!(pos_client(&f, &id).debt(), debt_before - repaid);
    // The buffer paid, and the same amount is now queued against the vault.
    assert_eq!(f.c.buffer(), buffer_before - repaid);
    assert_eq!(f.vault.queued(&id), repaid);
    // The stock never moved. That is the promise.
    assert_eq!(pos_client(&f, &id).collateral(), 10_0000000);
}

#[test]
fn without_a_buffer_a_fall_cannot_be_answered_and_says_so() {
    // A buffer of one dollar against a position that will owe 2,940.
    let f = setup_with(1_0000000);
    let id = f.c.earn_deposit(&f.user, &f.stock.address, &10_0000000, &LTV);
    f.oracle
        .set_price(&oracle_contract::Asset::Stellar(f.stock.address.clone()), &(PRICE / 2));
    assert_eq!(f.c.try_rebalance(&f.agent, &id), Err(Ok(Error::BufferEmpty)));
    // And nothing happened: the debt stands, the stock is untouched.
    assert_eq!(pos_client(&f, &id).debt(), 2_940_0000000);
    assert_eq!(pos_client(&f, &id).collateral(), 10_0000000);
}

#[test]
fn compound_turns_returned_yield_into_more_shares() {
    let f = setup();
    let id = f.c.earn_deposit(&f.user, &f.stock.address, &10_0000000, &LTV);
    let shares_before = pos_client(&f, &id).collateral();

    // The queue settled and paid the position some dollars: that is yield.
    f.usdc.mint(&id, &420_0000000);
    let bought = f.c.compound(&f.agent, &id);

    // 420 dollars at 420 a share is one share.
    assert_eq!(bought, 1_0000000);
    assert_eq!(pos_client(&f, &id).collateral(), shares_before + 1_0000000);
    assert_eq!(token::Client::new(&f.e, &f.usdc_id).balance(&id), 0);
}

#[test]
fn compound_on_a_position_with_no_yield_is_a_no_op_that_still_signs() {
    let f = setup();
    let id = f.c.earn_deposit(&f.user, &f.stock.address, &10_0000000, &LTV);
    assert_eq!(f.c.compound(&f.agent, &id), 0);
    assert_eq!(pos_client(&f, &id).last_touch().unwrap().action, symbol_short!("compnd"));
}

#[test]
fn closing_repays_everything_and_hands_the_stock_back() {
    let f = setup();
    let id = f.c.earn_deposit(&f.user, &f.stock.address, &10_0000000, &LTV);
    let held_before = f.stock.balance(&f.user);

    let returned = f.c.earn_close(&f.user, &f.stock.address);
    assert_eq!(returned, 10_0000000);
    assert_eq!(f.stock.balance(&f.user), held_before + 10_0000000);
    assert_eq!(pos_client(&f, &id).debt(), 0);
    assert_eq!(f.c.position_of(&f.user, &f.stock.address, &Product::Earn), None);
}

#[test]
fn amplify_loops_until_it_holds_the_multiple() {
    let f = setup();
    // Three times the deposit: thirty shares standing on ten.
    let id = f.c.amplify_open(&f.user, &f.stock.address, &10_0000000, &30_000);
    let p = pos_client(&f, &id);

    assert_eq!(p.collateral(), 30_0000000);
    // Three dollars of stock on one of your own is two borrowed, which at
    // 420 a share is 8,400.
    assert_eq!(p.debt(), 8_400_0000000);
    // A multiple of L carries an LTV of (L - 1) / L: two thirds.
    assert_eq!(f.c.health(&id).ltv, 6666);
}

#[test]
fn the_market_ceiling_is_what_caps_the_multiple() {
    let f = setup();
    // 1 / (1 - 0.7) is 3.33x, so 3.3x is the most a 70% market will hold and
    // the LTV it carries lands just under the ceiling rather than on it.
    let id = f.c.amplify_open(&f.user, &f.stock.address, &10_0000000, &33_000);
    let p = pos_client(&f, &id);
    assert_eq!(p.collateral(), 33_0000000);
    assert_eq!(p.debt(), 9_660_0000000);
    assert_eq!(f.c.health(&id).ltv, 6969);
    assert!(f.c.health(&id).ltv <= f.c.health(&id).max_ltv);
}

#[test]
fn a_multiple_the_market_cannot_hold_is_refused() {
    let f = setup();
    // 1 / (1 - 0.7) is 3.33x. Four times would need an LTV of 75%.
    assert_eq!(
        f.c.try_amplify_open(&f.user, &f.stock.address, &10_0000000, &40_000),
        Err(Ok(Error::BadTarget))
    );
    // And so is standing still: a multiple of one borrows nothing.
    assert_eq!(
        f.c.try_amplify_open(&f.user, &f.stock.address, &10_0000000, &10_000),
        Err(Ok(Error::BadTarget))
    );
}

#[test]
fn liquidation_refuses_a_healthy_position() {
    let f = setup();
    let id = f.c.earn_deposit(&f.user, &f.stock.address, &10_0000000, &LTV);
    assert_eq!(f.c.try_liquidate(&f.agent, &id), Err(Ok(Error::Healthy)));
}

#[test]
fn liquidation_repays_out_of_the_buffer_before_anyone_takes_stock() {
    let f = setup();
    let id = f.c.earn_deposit(&f.user, &f.stock.address, &10_0000000, &LTV);
    let collateral_before = pos_client(&f, &id).collateral();
    let buffer_before = f.c.buffer();

    // Down far enough to cross the 80% threshold: 70 / 0.85 is 82.4%.
    f.oracle
        .set_price(&oracle_contract::Asset::Stellar(f.stock.address.clone()), &(PRICE * 85 / 100));
    let repaid = f.c.liquidate(&f.agent, &id);

    assert!(repaid > 0);
    assert_eq!(f.c.buffer(), buffer_before - repaid);
    // Back inside the target, and not one share changed hands.
    assert!(f.c.health(&id).ltv <= LTV);
    assert_eq!(pos_client(&f, &id).collateral(), collateral_before);
    assert_eq!(pos_client(&f, &id).last_touch().unwrap().action, symbol_short!("liq"));
}

#[test]
fn an_unknown_market_is_not_a_market() {
    let f = setup();
    let other = Address::generate(&f.e);
    assert_eq!(
        f.c.try_earn_deposit(&f.user, &other, &1, &LTV),
        Err(Ok(Error::UnknownMarket))
    );
}

#[test]
fn a_disabled_market_takes_nothing_new() {
    let f = setup();
    f.c.set_enabled(&f.stock.address, &false);
    assert_eq!(
        f.c.try_earn_deposit(&f.user, &f.stock.address, &1_0000000, &LTV),
        Err(Ok(Error::MarketDisabled))
    );
}

#[test]
fn pausing_stops_every_market_at_once() {
    let f = setup();
    f.c.set_paused(&true);
    assert_eq!(
        f.c.try_earn_deposit(&f.user, &f.stock.address, &1_0000000, &LTV),
        Err(Ok(Error::Paused))
    );
    f.c.set_paused(&false);
    f.c.earn_deposit(&f.user, &f.stock.address, &1_0000000, &LTV);
}

#[test]
fn the_buffer_is_anyones_to_fill_and_everyones_to_see() {
    let f = setup();
    let stranger = Address::generate(&f.e);
    f.usdc.mint(&stranger, &100_0000000);
    let before = f.c.buffer();
    f.c.fund_buffer(&stranger, &100_0000000);
    assert_eq!(f.c.buffer(), before + 100_0000000);
    assert_eq!(f.c.try_fund_buffer(&stranger, &0), Err(Ok(Error::BadAmount)));
    let _ = f.admin;
}

#[test]
fn a_rise_on_an_amplify_buys_stock_rather_than_filling_the_vault() {
    let f = setup();
    let id = f.c.amplify_open(&f.user, &f.stock.address, &10_0000000, &30_000);
    let p = pos_client(&f, &id);
    let before = p.collateral();
    let in_vault_before = f.vault.deposited(&id);

    // Up ten percent.
    f.oracle.set_price(
        &oracle_contract::Asset::Stellar(f.stock.address.clone()),
        &(PRICE * 110 / 100),
    );
    f.c.rebalance(&f.agent, &id);

    // The borrowing bought stock. This is the whole difference between the
    // two products once they are open, and the failure it guards against is
    // the quiet one: send an Amplify's borrowings to the vault and the LTV
    // still reads correct while the multiple decays.
    assert!(p.collateral() > before);
    assert_eq!(f.vault.deposited(&id), in_vault_before);
    // 6667 rather than 6666: the sale is rounded up by a unit so it covers
    // the debt rather than leaving a remainder for the next pass.
    assert_eq!(f.c.health(&id).ltv, 6667);
}

#[test]
fn a_fall_on_an_amplify_sells_just_enough_and_not_the_deposit() {
    let f = setup();
    let id = f.c.amplify_open(&f.user, &f.stock.address, &10_0000000, &30_000);
    let p = pos_client(&f, &id);
    let owed = p.debt();
    let buffer_before = f.c.buffer();

    f.oracle.set_price(
        &oracle_contract::Asset::Stellar(f.stock.address.clone()),
        &(PRICE * 90 / 100),
    );
    f.c.rebalance(&f.agent, &id);

    // Stock went back, because an Amplify has no vault balance to draw on:
    // its dollars are all in stock by construction.
    assert!(p.collateral() < 30_0000000);
    assert!(p.debt() < owed);
    // The buffer is for Earn positions, and this did not touch it.
    assert_eq!(f.c.buffer(), buffer_before);
    // And the deposit itself survived: the sale is sized to the debt, not to
    // the position.
    assert!(p.collateral() > 10_0000000);
    assert_eq!(f.c.health(&id).ltv, 6667);
}

#[test]
fn the_faucet_hands_out_every_market_in_one_call() {
    let f = setup();
    let visitor = Address::generate(&f.e);
    assert_eq!(f.stock.balance(&visitor), 0);

    // One market in this fixture. The dollar here is a stellar asset
    // contract, which has no faucet at all, and it is skipped exactly the way
    // a token on cooldown is: not counted, not fatal. On testnet the dollar
    // is the same SEP-41 as the stocks and does drip.
    assert_eq!(f.c.faucet(&visitor), 1);
    assert!(f.stock.balance(&visitor) > 0);
}

#[test]
fn a_token_on_cooldown_does_not_take_the_others_down_with_it() {
    let f = setup();
    let visitor = Address::generate(&f.e);
    f.stock.faucet(&visitor);
    let after_one = f.stock.balance(&visitor);

    // Nothing reverts, nothing is given, and the call says so. A click that
    // reverted the other ten because one was claimed four minutes ago reads
    // as a broken faucet.
    assert_eq!(f.c.faucet(&visitor), 0);
    assert_eq!(f.stock.balance(&visitor), after_one);
}

#[test]
fn the_faucet_says_how_long_each_one_has_to_wait() {
    let f = setup();
    let visitor = Address::generate(&f.e);
    let ready = f.c.faucet_in(&visitor);
    assert_eq!(ready.len(), 2);
    assert!(ready.iter().all(|s| s == 0));

    f.c.faucet(&visitor);
    // The market is waiting now; the stellar asset contract has nothing to
    // say and reports zero rather than failing the read.
    let waiting = f.c.faucet_in(&visitor);
    assert!(waiting.get(0).unwrap() > 0);
    assert_eq!(waiting.get(1).unwrap(), 0);
}

#[test]
fn the_unsigned_drip_needs_nobodys_signature() {
    let f = setup();
    let visitor = Address::generate(&f.e);
    // No mocked auth at all: the real auth tree is checked, and this call has
    // none to satisfy. That is the whole point of it. A smart account
    // authorizes one contract per rule its owner approves by passkey, so the
    // signed faucet's twelve contexts are twelve confirmations; this is zero.
    f.e.set_auths(&[]);
    assert_eq!(f.c.faucet_for(&visitor), 1);
    assert_eq!(f.stock.balance(&visitor), f.stock.drip());
}

#[test]
fn the_unsigned_drip_waits_an_hour_per_address() {
    let f = setup();
    let visitor = Address::generate(&f.e);
    f.c.faucet_for(&visitor);
    assert_eq!(f.c.try_faucet_for(&visitor), Err(Ok(Error::FaucetCooldown)));
    assert!(f.c.faucet_for_in(&visitor) > 0);

    // Another address is another address, and the hour is its own.
    let other = Address::generate(&f.e);
    assert_eq!(f.c.faucet_for_in(&other), 0);
    assert_eq!(f.c.faucet_for(&other), 1);

    f.e.ledger().set_timestamp(f.e.ledger().timestamp() + 3600);
    assert_eq!(f.c.faucet_for_in(&visitor), 0);
    assert_eq!(f.c.faucet_for(&visitor), 1);
    assert_eq!(f.stock.balance(&visitor), f.stock.drip() * 2);
}

/// A core whose dollar is one of these stand-in tokens rather than a stellar
/// asset contract, which is what testnet actually has: a dollar with a faucet
/// of its own.
fn setup_with_dripping_dollar() -> (Env, CoreClient<'static>, stock::StockClient<'static>, stock::StockClient<'static>) {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().set_timestamp(1_700_000_000);
    let admin = Address::generate(&e);

    let dollar_id = e.register(
        stock::Stock,
        (
            admin.clone(),
            7u32,
            String::from_str(&e, "Dollar"),
            String::from_str(&e, "USDC"),
            100_0000000i128,
            3600u64,
        ),
    );
    let stock_id = e.register(
        stock::Stock,
        (
            admin.clone(),
            7u32,
            String::from_str(&e, "Tesla"),
            String::from_str(&e, "TSLAx"),
            10_0000000i128,
            3600u64,
        ),
    );
    let dollar = stock::StockClient::new(&e, &dollar_id);
    let stock = stock::StockClient::new(&e, &stock_id);
    let wasm = e
        .deployer()
        .upload_contract_wasm(Bytes::from_slice(&e, POSITION_WASM));
    let core_id = e.register(
        Core,
        (
            admin.clone(),
            dollar_id.clone(),
            USDC_IX,
            Address::generate(&e),
            Address::generate(&e),
            Address::generate(&e),
            wasm,
            MAX_AGE,
        ),
    );
    let c = CoreClient::new(&e, &core_id);
    c.add_market(&stock_id, &STOCK_IX, &LTV, &THRESHOLD, &OFF_HOURS);
    stock.set_admin(&core_id);
    // A buffer of a thousand dollars, and nothing above it.
    dollar.mint(&admin, &1_000_0000000);
    c.fund_buffer(&admin, &1_000_0000000);
    (e, c, stock, dollar)
}

#[test]
fn the_unsigned_drip_pays_the_dollar_out_of_what_is_above_the_buffer() {
    let (e, c, stock, dollar) = setup_with_dripping_dollar();
    let visitor = Address::generate(&e);
    let buffer = c.buffer();

    // Two assets: the stock minted, the dollar paid out of the hundred the
    // core just claimed from the dollar's own faucet.
    assert_eq!(c.faucet_for(&visitor), 2);
    assert_eq!(stock.balance(&visitor), stock.drip());
    assert_eq!(dollar.balance(&visitor), dollar.drip());
    // The buffer is for falling positions. A visitor's test dollars do not
    // come out of it, and the number says so.
    assert_eq!(c.buffer(), buffer);
    assert_eq!(dollar.balance(&c.address), buffer);
}

#[test]
fn a_dollar_the_core_cannot_cover_does_not_cost_the_visitor_their_stock() {
    let (e, c, stock, dollar) = setup_with_dripping_dollar();
    let first = Address::generate(&e);
    let second = Address::generate(&e);
    // The first visitor takes the hour's hundred dollars.
    assert_eq!(c.faucet_for(&first), 2);
    // The second arrives inside the same hour, so the dollar's faucet gives
    // the core nothing and the buffer is not available. The stock still
    // arrives, because a dollar nobody can pay is not a reason to withhold it.
    assert_eq!(c.faucet_for(&second), 1);
    assert_eq!(stock.balance(&second), stock.drip());
    assert_eq!(dollar.balance(&second), 0);
    assert_eq!(dollar.balance(&c.address), c.buffer());
}

#[test]
fn a_position_can_be_closed_the_minute_it_is_opened() {
    let f = setup();
    let id = f.c.earn_deposit(&f.user, &f.stock.address, &10_0000000, &LTV);
    let p = pos_client(&f, &id);
    let in_vault = f.vault.deposited(&id);

    // A minute of interest, which is all it takes. The debt grows in the
    // pool's d_rate and the vault's share price does not follow it, so the
    // position now owes more than its vault balance is worth. A close repays
    // the debt out of the buffer and files the refund against the vault: ask
    // for the whole debt and the vault refuses, because the shares to burn
    // are not there. That refusal used to be the end of the position.
    f.pool.accrue(&1_000_010_000_000);
    let owed = p.debt();
    assert!(owed > in_vault, "the debt has to have outgrown the deposit");

    let back = f.c.earn_close(&f.user, &f.stock.address);
    assert_eq!(back, 10_0000000);
    assert_eq!(p.debt(), 0);
    // The request is for what the position holds, and the difference is the
    // buffer's to carry: it repaid a debt that the vault cannot fully return.
    assert_eq!(f.vault.queued(&id), in_vault);
    assert_eq!(f.stock.balance(&f.user), 100_0000000);
}
