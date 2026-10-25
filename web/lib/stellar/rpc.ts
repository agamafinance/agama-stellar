import { Contract, rpc, scValToNative, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { PASSPHRASE, RPC } from './config';

export const server = new rpc.Server(RPC);

/// A read that costs nothing: simulate the call, keep the return value.
///
/// Simulation needs a source account but never charges it, so any funded
/// testnet account works. This one is the deployer, and it holds nothing that
/// a simulation could spend.
const READER = 'GBRTAI652CMHCAFC6GCYXASWFM2GR7DNRF5QUYA643YGUT3FUAK6GXE4';

let account: Awaited<ReturnType<typeof server.getAccount>> | null = null;
let fetched = 0;

async function reader() {
  // The sequence number does not matter for a simulation, so this is cached
  // for a minute rather than fetched before each of the seventy reads a
  // snapshot makes.
  if (!account || Date.now() - fetched > 60_000) {
    account = await server.getAccount(READER);
    fetched = Date.now();
  }
  return account;
}

export async function read<T = unknown>(
  contractId: string,
  fn: string,
  args: xdr.ScVal[] = [],
): Promise<T | null> {
  try {
    const tx = new TransactionBuilder(await reader(), { fee: '100', networkPassphrase: PASSPHRASE })
      .addOperation(new Contract(contractId).call(fn, ...args))
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) return null;
    if (!sim.result?.retval) return null;
    return scValToNative(sim.result.retval) as T;
  } catch {
    return null;
  }
}
