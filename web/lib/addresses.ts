// Addresses, safe to import from a client component.
//
// lib/markets.ts cannot be: it pulls in the RPC client, which would drag the
// whole SDK into the browser bundle for the sake of five strings. This file is
// the five strings.
import { dep } from './deployment'

export const CORE = dep.contracts.core
export const ORACLE = dep.contracts.oracle
export const VAULT = dep.contracts.vault
export const POOL = dep.blend.pool
export const USDC = dep.blend.usdc
