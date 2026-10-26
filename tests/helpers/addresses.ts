import { createHash } from 'crypto';
import { Keypair, StrKey } from '@stellar/stellar-sdk';

const accounts = new Map<string, string>();
const contracts = new Map<string, string>();

/**
 * Stable, valid Stellar account for a label within one test file.
 * Uses Keypair.random() so checksums are always correct.
 */
export function account(label: string): string {
  let value = accounts.get(label);
  if (!value) {
    value = Keypair.random().publicKey();
    accounts.set(label, value);
  }
  return value;
}

/** Stable, valid C… contract address for a label within one test file. */
export function contract(label: string): string {
  let value = contracts.get(label);
  if (!value) {
    value = StrKey.encodeContract(createHash('sha256').update(label).digest());
    contracts.set(label, value);
  }
  return value;
}
