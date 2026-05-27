import { reputationStore } from './reputation.store';
import { ReputationProfile } from '../types/reputation';

describe('ReputationStore', () => {
  const profile: ReputationProfile = {
    freelancerId: 'user-1',
    score: 5,
    jobsCompleted: 1,
    totalRatings: 1,
    reviews: [],
    lastUpdated: new Date().toISOString()
  };

  beforeEach(() => {
    reputationStore.clear();
  });

  it('should set and get a profile', () => {
    reputationStore.set(profile);
    expect(reputationStore.get('user-1')).toEqual(profile);
  });

  it('should return undefined if profile does not exist', () => {
    expect(reputationStore.get('unknown')).toBeUndefined();
  });

  it('should correctly report if a profile exists (has)', () => {
    reputationStore.set(profile);
    expect(reputationStore.has('user-1')).toBe(true);
    expect(reputationStore.has('user-2')).toBe(false);
  });

  it('should delete a profile', () => {
    reputationStore.set(profile);
    expect(reputationStore.has('user-1')).toBe(true);
    reputationStore.delete('user-1');
    expect(reputationStore.has('user-1')).toBe(false);
  });
});
