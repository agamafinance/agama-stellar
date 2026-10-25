# Vendored Blend wasm

`blend_pool.wasm` and `blend_pool_factory.wasm` are the Blend v2 contracts, taken
from [blend-capital/blend-contract-sdk](https://github.com/blend-capital/blend-contract-sdk)
at version 2.25.0.

They are here to be read, not to be deployed: `contractimport!` generates a typed
client from a wasm's own spec, so these files are how our contracts learn the
shape of `submit`, `Request` and `Positions` without us retyping them and
without taking a dependency that pins a different soroban-sdk (theirs is 25,
ours is 23).

The pools we call are the ones already deployed on testnet. The factory wasm is
kept for the deploy script, which creates our pool through the factory that is
live, not through this copy.

Request type codes, read off `blend-contracts-v2/pool/src/pool/actions.rs`:

| | |
|---|---|
| 0 | Supply |
| 1 | Withdraw |
| 2 | SupplyCollateral |
| 3 | WithdrawCollateral |
| 4 | Borrow |
| 5 | Repay |
| 6 | FillUserLiquidationAuction |
| 7 | FillBadDebtAuction |
| 8 | FillInterestAuction |
| 9 | DeleteLiquidationAuction |
