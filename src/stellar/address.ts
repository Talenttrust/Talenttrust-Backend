/**
 * Stellar strkey validation and normalisation for every address that enters
 * the API. Only values that can exist on-chain are accepted: G… ed25519
 * accounts and C… contract addresses (with valid checksums).
 *
 * Error messages never include the submitted value, so a secret seed pasted
 * into an address field cannot be echoed back in a response or error log.
 */

import { StrKey } from '@stellar/stellar-sdk';
import { HttpError } from '../amount-error';
import { config } from '../config';

const MUXED_MESSAGE = 'muxed accounts are not supported; use the base G… address';

const invalidAccount = (field: string): HttpError =>
  new HttpError(400, 'invalid_address', `${field} must be a valid Stellar account address (G…)`);

const invalidContract = (field: string): HttpError =>
  new HttpError(400, 'invalid_address', `${field} must be a valid Stellar contract address (C…)`);

/** Trim and upper-case a raw strkey before checksum validation. */
const normalise = (raw: unknown, field: string, message: HttpError): string => {
  if (typeof raw !== 'string') throw message;
  const value = raw.trim().toUpperCase();
  if (!value) throw message;
  return value;
};

/**
 * Validate and normalise a Stellar account address (G… ed25519 public key).
 * Muxed accounts (M…) are rejected: escrow parties are base accounts.
 */
export function parseAccount(raw: unknown, field = 'address'): string {
  const value = normalise(raw, field, invalidAccount(field));
  if (StrKey.isValidMed25519PublicKey(value)) {
    throw new HttpError(400, 'invalid_address', `${field}: ${MUXED_MESSAGE}`);
  }
  if (!StrKey.isValidEd25519PublicKey(value)) throw invalidAccount(field);
  return value;
}

/** Validate and normalise a Stellar contract address (C… strkey). */
export function parseContractAddress(raw: unknown, field = 'token'): string {
  const value = normalise(raw, field, invalidContract(field));
  if (!StrKey.isValidContract(value)) throw invalidContract(field);
  return value;
}

export interface ParsedToken {
  /** Resolved C… contract id stored on the record. */
  token: string;
  /** 'XLM' for the native asset, otherwise null. */
  tokenSymbol: string | null;
}

/**
 * Resolve a token input to the contract address the Soroban contract expects.
 * Accepts a C… contract id or the aliases `native` / `XLM`, which resolve to
 * the network's native Stellar Asset Contract id (NATIVE_TOKEN_CONTRACT_ID).
 */
export function parseToken(raw: unknown, field = 'token'): ParsedToken {
  if (raw === undefined || raw === null || raw === '') {
    return { token: config.nativeTokenContractId, tokenSymbol: 'XLM' };
  }
  if (typeof raw !== 'string') {
    throw new HttpError(400, 'invalid_address', `${field} must be a Stellar contract address (C…) or "native"`);
  }
  const alias = raw.trim().toUpperCase();
  if (alias === 'NATIVE' || alias === 'XLM') {
    return { token: config.nativeTokenContractId, tokenSymbol: 'XLM' };
  }
  return { token: parseContractAddress(raw, field), tokenSymbol: null };
}
