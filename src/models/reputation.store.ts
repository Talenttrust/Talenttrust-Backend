import { ReputationProfile } from '../types/reputation';

/**
 * @title Reputation Store
 * @dev NatSpec: Mock in-memory persistence layer for Freelancer Reputation Profiles.
 */
class ReputationStore {
  private profiles: Map<string, ReputationProfile>;

  constructor() {
    this.profiles = new Map<string, ReputationProfile>();
  }

  /**
   * @notice Get a profile by freelancerId
   * @param id The freelancer identifier
   * @return The profile if found, otherwise undefined
   */
  public get(id: string): ReputationProfile | undefined {
    return this.profiles.get(id);
  }

  /**
   * @notice Set or update a profile
   * @param profile The full reputation profile object
   */
  public set(profile: ReputationProfile): void {
    this.profiles.set(profile.freelancerId, profile);
  }

  /**
   * @notice Check if a profile exists
   * @param id The freelancer identifier
   * @return True if exists, else false
   */
  public has(id: string): boolean {
    return this.profiles.has(id);
  }

  /**
   * @notice Delete a profile (useful for tests)
   * @param id The freelancer identifier
   */
  public delete(id: string): void {
    this.profiles.delete(id);
  }

  /**
   * @notice Clear all profiles (useful for tests)
   */
  public clear(): void {
    this.profiles.clear();
  }
}

// Export a singleton instance for simplicity
export const reputationStore = new ReputationStore();
