import { isValidReputationRatingPayload } from './reputation.validation';

describe('isValidReputationRatingPayload', () => {
  const validPayload = {
    reviewerId: 'reviewer-1',
    rating: 3,
    contextId: 'contract-1',
  };

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a primitive', 'payload'],
    ['an empty object', {}],
    ['a missing reviewerId', { rating: 3 }],
    ['an empty reviewerId', { reviewerId: '', rating: 3 }],
    ['a missing rating', { reviewerId: 'reviewer-1' }],
    ['a string rating', { reviewerId: 'reviewer-1', rating: '3' }],
    ['NaN', { reviewerId: 'reviewer-1', rating: Number.NaN }],
    ['positive Infinity', { reviewerId: 'reviewer-1', rating: Number.POSITIVE_INFINITY }],
    ['negative Infinity', { reviewerId: 'reviewer-1', rating: Number.NEGATIVE_INFINITY }],
    ['a decimal below the upper bound', { reviewerId: 'reviewer-1', rating: 4.9 }],
    ['a decimal above the lower bound', { reviewerId: 'reviewer-1', rating: 1.5 }],
    ['zero', { reviewerId: 'reviewer-1', rating: 0 }],
    ['a negative rating', { reviewerId: 'reviewer-1', rating: -1 }],
    ['a rating above the maximum', { reviewerId: 'reviewer-1', rating: 6 }],
  ])('rejects %s', (_case, payload) => {
    expect(isValidReputationRatingPayload(payload)).toBe(false);
  });

  it('rejects truthy non-string reviewerId (boolean)', () => {
    expect(isValidReputationRatingPayload({ reviewerId: true, rating: 3 })).toBe(false);
  });

  it.each([1, 2, 3, 4, 5])('accepts integer rating %i', (rating) => {
    expect(isValidReputationRatingPayload({ ...validPayload, rating })).toBe(true);
  });

  it('allows unrelated payload fields', () => {
    expect(
      isValidReputationRatingPayload({
        ...validPayload,
        comment: 'Great work',
        extra: true,
      }),
    ).toBe(true);
  });
});
