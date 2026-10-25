import {
  Contract,
  rpc,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk'
import { PASSPHRASE, RPC } from './deployment'

const server = new rpc.Server(RPC)

/// Build, simulate, sign, send, and wait.
///
/// The simulate step is not optional and not an optimisation: a Soroban
/// transaction has to carry the exact ledger entries it will touch and the
/// resources it will use, and only the network can work those out. Skipping
/// it produces a transaction that is rejected for a reason that has nothing
/// to do with what it was trying to do.
export async function send(
  source: string,
  contractId: string,
  fn: string,
  args: xdr.ScVal[],
  sign: (xdr: string) => Promise<string>,
): Promise<{ hash: string; value: unknown }> {
  const account = await server.getAccount(source)
  const contract = new Contract(contractId)
  const built = new TransactionBuilder(account, {
    fee: '10000000',
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(contract.call(fn, ...args))
    .setTimeout(120)
    .build()

  const sim = await server.simulateTransaction(built)
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(readable(sim.error))
  }
  const prepared = rpc.assembleTransaction(built, sim).build()
  const signed = await sign(prepared.toXDR())
  const tx = TransactionBuilder.fromXDR(signed, PASSPHRASE)

  const sent = await server.sendTransaction(tx)
  if (sent.status === 'ERROR') throw new Error(`rejected: ${JSON.stringify(sent.errorResult)}`)

  // Poll rather than assume. A transaction that was accepted for inclusion
  // has not necessarily succeeded, and the difference matters here: a failed
  // deposit that the page reports as done is worse than one that errors.
  for (let i = 0; i < 40; i++) {
    const got = await server.getTransaction(sent.hash)
    if (got.status === 'SUCCESS') {
      return { hash: sent.hash, value: got.returnValue }
    }
    if (got.status === 'FAILED') throw new Error(`failed on chain: ${sent.hash}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`still pending after 40s: ${sent.hash}`)
}

/// Contract errors arrive as a wall of diagnostic text with the useful part
/// buried in it. This pulls out the part a person can act on.
function readable(raw: string): string {
  const contract = raw.match(/Error\(Contract, #(\d+)\)/)
  if (contract) return `${NAMES[contract[1]] ?? `contract error ${contract[1]}`}`
  if (raw.includes('Error(Auth')) return 'the wallet did not authorise this'
  const first = raw.split('\n')[0]
  return first.length > 160 ? first.slice(0, 160) + '…' : first
}

/// The core's error codes, in words. Worth keeping in step with the contract:
/// a number alone sends the reader to the source for something the screen
/// could have told them.
const NAMES: Record<string, string> = {
  '1': 'not the admin',
  '2': 'that market is not open',
  '3': 'amount has to be positive',
  '4': 'target above what this market allows',
  '5': 'no position there',
  '6': 'the price is too old to act on',
  '7': 'the buffer is empty',
  '8': 'paused',
  '9': 'that position is healthy',
  '10': 'already open',
}
