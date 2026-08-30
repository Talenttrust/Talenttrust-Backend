import { randomUUID } from 'crypto';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors/appError';

export interface Credential {
  id: string;
  tenantId: string;
  userId: string;
  achievementId: string;
  eventId: string;
  status: 'active' | 'revoked';
  issuedAt: Date;
}

export interface IssueCredentialInput {
  tenantId: string;
  userId: string;
  achievementId: string;
  eventId: string;
}

// In-memory store following existing conventions
const credentialStore = new Map<string, Credential>();
// uniqueness index: tenantId:userId:achievementId -> credentialId
const uniquenessIndex = new Map<string, string>();

export class AchievementsService {
  /**
   * Issues a credential for an achievement.
   * Idempotent: If the same eventId is replayed, returns the existing credential.
   * Unique: A user can only have one credential per achievement.
   */
  public async issueCredential(input: IssueCredentialInput): Promise<Credential> {
    const { tenantId, userId, achievementId, eventId } = input;
    const identityKey = `${tenantId}:${userId}:${achievementId}`;
    
    // Check if user already has a credential for this achievement
    const existingId = uniquenessIndex.get(identityKey);
    
    if (existingId) {
      const existingCredential = credentialStore.get(existingId);
      
      if (existingCredential) {
        // Idempotent replay: if it's the exact same event, return the existing credential
        if (existingCredential.eventId === eventId) {
          return existingCredential;
        }
        
        // If it's a DIFFERENT event trying to issue the same achievement
        if (existingCredential.status === 'revoked') {
          // If revoked, we reject new issuances for the same achievement
          throw new ForbiddenError('Credential for this achievement was revoked');
        }
        
        throw new ConflictError('User already has an active credential for this achievement');
      }
    }
    
    // First issuance
    const credentialId = randomUUID();
    const newCredential: Credential = {
      id: credentialId,
      tenantId,
      userId,
      achievementId,
      eventId,
      status: 'active',
      issuedAt: new Date(),
    };
    
    // Enforce uniqueness atomically (synchronous map updates)
    uniquenessIndex.set(identityKey, credentialId);
    credentialStore.set(credentialId, newCredential);
    
    return newCredential;
  }
  
  public async revokeCredential(id: string): Promise<Credential> {
    const cred = credentialStore.get(id);
    if (!cred) {
      throw new NotFoundError('Credential not found');
    }
    
    cred.status = 'revoked';
    credentialStore.set(id, cred);
    return cred;
  }

  // Internal test helper to clear state
  public _clear(): void {
    credentialStore.clear();
    uniquenessIndex.clear();
  }
}

export const achievementsService = new AchievementsService();
