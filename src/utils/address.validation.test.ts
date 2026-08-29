import { validateDestinationAddress } from './address.validation';
import { ValidationError } from '../errors/appError';

describe('validateDestinationAddress', () => {
  const VALID_ACCOUNT = 'GBJDSMTMG4YBPW75YILPTYWVKNDN754YNY4YHYJ6W2Z2G7Z3N7M5UQQO';
  const VALID_CONTRACT = 'CCJZ5DGASBWQXR5MPFCJXMBI333XE5U3FSJTNQU7RIKE3P5GN2K2WYD5';

  it('accepts a valid address (account)', () => {
    expect(validateDestinationAddress(VALID_ACCOUNT)).toBe(VALID_ACCOUNT);
  });

  it('accepts a valid address (contract)', () => {
    expect(validateDestinationAddress(VALID_CONTRACT)).toBe(VALID_CONTRACT);
  });

  it('normalizes safe presentation differences (whitespace and lowercase)', () => {
    const mixedCase = `  ${VALID_ACCOUNT.toLowerCase()}  `;
    expect(validateDestinationAddress(mixedCase)).toBe(VALID_ACCOUNT);
  });

  it('rejects wrong network (e.g., Algorand address or invalid prefix)', () => {
    const algorandAddr = '737O445B4Z7F5M653K7D3534B46F54D7D76Z67G42V3D5B56K3Z4Y6B42I';
    expect(() => validateDestinationAddress(algorandAddr)).toThrow(ValidationError);
    expect(() => validateDestinationAddress(algorandAddr)).toThrow('wrong network');

    const wrongPrefix = 'MBJDSMTMG4YBPW75YILPTYWVKNDN754YNY4YHYJ6W2Z2G7Z3N7M5UQQO';
    expect(() => validateDestinationAddress(wrongPrefix)).toThrow(ValidationError);
    expect(() => validateDestinationAddress(wrongPrefix)).toThrow('wrong network');
  });

  it('rejects contract address where account required', () => {
    expect(() => validateDestinationAddress(VALID_CONTRACT, { requireAccount: true }))
      .toThrow(ValidationError);
    expect(() => validateDestinationAddress(VALID_CONTRACT, { requireAccount: true }))
      .toThrow('contract address where account required');
  });

  it('rejects malformed base32 (invalid character)', () => {
    // '0' is not in the Stellar base32 alphabet
    const malformed = 'G0JDSMTMG4YBPW75YILPTYWVKNDN754YNY4YHYJ6W2Z2G7Z3N7M5UQQO';
    expect(() => validateDestinationAddress(malformed)).toThrow(ValidationError);
    expect(() => validateDestinationAddress(malformed)).toThrow('malformed base32');
  });

  it('rejects malformed base32 (invalid checksum)', () => {
    // Valid characters but wrong checksum
    const badChecksum = 'GBJDSMTMG4YBPW75YILPTYWVKNDN754YNY4YHYJ6W2Z2G7Z3N7M5UQQA';
    expect(() => validateDestinationAddress(badChecksum)).toThrow(ValidationError);
    expect(() => validateDestinationAddress(badChecksum)).toThrow('malformed base32');
  });

  it('rejects blank address', () => {
    expect(() => validateDestinationAddress('')).toThrow(ValidationError);
    expect(() => validateDestinationAddress('')).toThrow('blank address');
    
    expect(() => validateDestinationAddress('   ')).toThrow(ValidationError);
    expect(() => validateDestinationAddress('   ')).toThrow('blank address');
    
    expect(() => validateDestinationAddress(null as any)).toThrow(ValidationError);
    expect(() => validateDestinationAddress(null as any)).toThrow('blank address');
  });
});
