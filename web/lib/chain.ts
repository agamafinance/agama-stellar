import { Contract, rpc, scValToNative, TransactionBuilder, xdr } from '@stellar/stellar-sdk'
import { PASSPHRASE, RPC } from './deployment'
import { addr, stellarAsset, unitEnum } from './scval'

const server = new rpc.Server(RPC)

/// A read that costs nothing: simulate the call and keep the return value.
///
/// Every number on this screen comes from here rather than from a cache or an
/// indexer, so what the page shows is what the contract would answer right
/// now. Slower than an indexer and worth it: a lending position displayed from
/// stale data is the one number a user cannot afford to be wrong.
export async function read<T = unknown>(
  contractId: string,
  fn: string,
  args: xdr.ScVal[] = [],
): Promise<T | null> {
  const contract = new Contract(contractId)
  // Simulation needs a source account but never charges it, so any funded
  // account works. This one exists on testnet and holds nothing.
  const source = 'GBRTAI652CMHCAFC6GCYXASWFM2GR7DNRF5QUYA643YGUT3FUAK6GXE4'
  const account = await server.getAccount(source)
  const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: PASSPHRASE })
    .addOperation(contract.call(fn, ...args))
    .setTimeout(30)
    .build()

  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) return null
  if (!sim.result?.retval) return null
  return scValToNative(sim.result.retval) as T
}

export { addr, stellarAsset, unitEnum, server }
