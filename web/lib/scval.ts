import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk'

/// Turning JavaScript values into the XDR a contract expects.
///
/// Split out of lib/chain.ts so a client component can build arguments
/// without the RPC client coming along with them.

export const addr = (s: string) => new Address(s).toScVal()

export const i128 = (n: bigint | string) => nativeToScVal(BigInt(n), { type: 'i128' })

export const u32 = (n: number) => nativeToScVal(n, { type: 'u32' })

/// A unit enum case travels as a one element vector holding the case name as a
/// symbol. `Product::Earn` is `["Earn"]`, not `"Earn"`.
export const unitEnum = (name: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)])

/// A SEP-40 asset, which is an enum with one case we ever use.
export const stellarAsset = (contractId: string) =>
  xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Stellar'), addr(contractId)])
