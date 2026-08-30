import { achievementsService } from './achievements.service';
import { ConflictError, ForbiddenError, NotFoundError } from '../errors/appError';

describe('AchievementsService', () => {
  beforeEach(() => {
    achievementsService._clear();
  });

  const baseInput = {
    tenantId: 'tenant-1',
    userId: 'user-1',
    achievementId: 'achieve-1',
    eventId: 'event-1',
  };

  it('handles first issuance successfully', async () => {
    const cred = await achievementsService.issueCredential(baseInput);
    
    expect(cred).toBeDefined();
    expect(cred.tenantId).toBe(baseInput.tenantId);
    expect(cred.userId).toBe(baseInput.userId);
    expect(cred.achievementId).toBe(baseInput.achievementId);
    expect(cred.eventId).toBe(baseInput.eventId);
    expect(cred.status).toBe('active');
    expect(cred.issuedAt).toBeInstanceOf(Date);
  });

  it('handles duplicate event (idempotent replay)', async () => {
    const cred1 = await achievementsService.issueCredential(baseInput);
    const cred2 = await achievementsService.issueCredential(baseInput);
    
    // Should return the exact same credential for the same event
    expect(cred1.id).toBe(cred2.id);
  });

  it('handles same user different achievement', async () => {
    const cred1 = await achievementsService.issueCredential(baseInput);
    const cred2 = await achievementsService.issueCredential({
      ...baseInput,
      achievementId: 'achieve-2',
      eventId: 'event-2',
    });
    
    // Should issue a new credential for a different achievement
    expect(cred1.id).not.toBe(cred2.id);
    expect(cred2.achievementId).toBe('achieve-2');
  });

  it('handles concurrent issuance correctly', async () => {
    // Fire two different events for the same achievement concurrently
    const input1 = { ...baseInput, eventId: 'event-concurrent-1' };
    const input2 = { ...baseInput, eventId: 'event-concurrent-2' };

    const results = await Promise.allSettled([
      achievementsService.issueCredential(input1),
      achievementsService.issueCredential(input2)
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    // One should succeed
    expect(fulfilled).toHaveLength(1);
    // One should fail due to uniqueness constraint
    expect(rejected).toHaveLength(1);

    if (rejected[0].status === 'rejected') {
      expect(rejected[0].reason).toBeInstanceOf(ConflictError);
    }
  });

  it('handles revoked prior credential', async () => {
    const cred1 = await achievementsService.issueCredential(baseInput);
    
    // Revoke the credential
    await achievementsService.revokeCredential(cred1.id);
    
    // Attempting to issue for the same achievement via a different event
    // should fail because they already had a revoked one
    const input2 = { ...baseInput, eventId: 'event-2' };
    
    await expect(achievementsService.issueCredential(input2))
      .rejects
      .toThrow(ForbiddenError);
  });

  it('returns not found when revoking invalid credential', async () => {
    await expect(achievementsService.revokeCredential('invalid-id'))
      .rejects
      .toThrow(NotFoundError);
  });
});
