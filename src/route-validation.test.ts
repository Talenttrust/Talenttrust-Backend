import { ApiError } from './errors/ApiError';
import {
  validateCreateContractBody,
  validateIdentifier,
} from './routes/contract-routes';

describe('contract route validation', () => {
  it('accepts a valid contract payload', () => {
    expect(
      validateCreateContractBody({
        title: 'Valid',
        clientId: 'client-1',
        freelancerId: 'free-1',
        budget: 42,
        currency: 'USDC',
      }),
    ).toEqual({
      title: 'Valid',
      clientId: 'client-1',
      freelancerId: 'free-1',
      budget: 42,
      currency: 'USDC',
    });
  });

  it('rejects non-object payloads', () => {
    expect(() => validateCreateContractBody(null)).toThrow(ApiError);
    expect(() => validateCreateContractBody([])).toThrow(ApiError);
  });

  it('rejects invalid identifiers', () => {
    expect(() => validateIdentifier('$')).toThrow(ApiError);
    expect(() => validateIdentifier('ok-id')).not.toThrow();
  });
});
