import { StrKey } from '@stellar/stellar-sdk';
import { ValidationError } from '../errors/appError';

export interface AddressValidationOptions {
  requireAccount?: boolean;
}

/**
 * Validates a blockchain address based on network and type expectations.
 * Normalizes safe presentation differences.
 * Rejects unsupported asset or destination combinations.
 *
 * @param address The address string (base32)
 * @param options Validation rules
 * @returns The safely normalized address
 * @throws {ValidationError} with a structured format if validation fails
 */
export function validateDestinationAddress(
  address: string,
  options: AddressValidationOptions = {}
): string {
  if (!address || typeof address !== 'string' || address.trim() === '') {
    throw new ValidationError('blank address');
  }

  const normalized = address.trim().toUpperCase();

  let isAccount = false;
  let isContract = false;

  try {
    if (normalized.startsWith('G')) {
      if (!StrKey.isValidEd25519PublicKey(normalized)) {
        throw new ValidationError('malformed base32');
      }
      isAccount = true;
    } else if (normalized.startsWith('C')) {
      if (!StrKey.isValidContract(normalized)) {
        throw new ValidationError('malformed base32');
      }
      isContract = true;
    } else {
      // Valid base32 length but different prefix (e.g., M or other)
      // or totally different network's base32
      throw new ValidationError('wrong network');
    }
  } catch (e: any) {
    if (e.message === 'wrong network' || e.name === 'ValidationError') {
      throw new ValidationError('wrong network');
    }
    throw new ValidationError('malformed base32');
  }

  if (options.requireAccount && isContract) {
    throw new ValidationError('contract address where account required');
  }

  return normalized;
}
