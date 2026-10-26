import { StrKey } from '@stellar/stellar-sdk';
import { HttpError } from '../amount-error';

export function parseAccount(raw: unknown, field: string): string {
  if (typeof raw !== 'string') {
    throw new HttpError(400, 'invalid_address', `${field} must be a valid Stellar account address`);
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new HttpError(400, 'invalid_address', `${field} must be a valid Stellar account address`);
  }
  // Check if it's a secret seed
  if (StrKey.isValidEd25519SecretSeed(trimmed) || trimmed.startsWith('S')) {
    throw new HttpError(400, 'invalid_address', `${field} must be a valid Stellar account address`);
  }
  // Check for muxed account
  if (trimmed.startsWith('M')) {
    throw new HttpError(400, 'invalid_address', 'muxed accounts are not supported; use the base G… address');
  }
  // Check for contract address passed as account
  if (trimmed.startsWith('C')) {
    throw new HttpError(400, 'invalid_address', `${field} must be a valid Stellar account address`);
  }
  const upper = trimmed.toUpperCase();
  if (!StrKey.isValidEd25519PublicKey(upper)) {
    throw new HttpError(400, 'invalid_address', `${field} must be a valid Stellar account address`);
  }
  return upper;
}

export function parseContractAddress(raw: unknown, field: string): string {
  if (typeof raw !== 'string') {
    throw new HttpError(400, 'invalid_address', `${field} must be a valid Stellar contract address`);
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new HttpError(400, 'invalid_address', `${field} must be a valid Stellar contract address`);
  }
  if (StrKey.isValidEd25519SecretSeed(trimmed) || trimmed.startsWith('S')) {
    throw new HttpError(400, 'invalid_address', `${field} must be a valid Stellar contract address`);
  }
  const upper = trimmed.toUpperCase();
  if (!StrKey.isValidContract(upper)) {
    throw new HttpError(400, 'invalid_address', `${field} must be a valid Stellar contract address`);
  }
  return upper;
}

export function isAccountAddress(raw: string): boolean {
  const upper = raw.trim().toUpperCase();
  return upper.startsWith('G') && StrKey.isValidEd25519PublicKey(upper);
}

export function isContractAddress(raw: string): boolean {
  const upper = raw.trim().toUpperCase();
  return upper.startsWith('C') && StrKey.isValidContract(upper);
}
