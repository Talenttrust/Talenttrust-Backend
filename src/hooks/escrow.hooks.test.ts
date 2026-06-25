import { EscrowHooks } from './escrow.hooks';
import { KeyEscrowEvent } from '../types/notification.types';
import { notificationService } from '../services/notification.service';

describe('EscrowHooks', () => {
  let sendEmailSpy: jest.SpyInstance;
  let sendWebSpy: jest.SpyInstance;

  beforeEach(() => {
    sendEmailSpy = jest.spyOn(notificationService, 'sendEmail').mockResolvedValue({ success: true } as any);
    sendWebSpy = jest.spyOn(notificationService, 'sendWebNotification').mockResolvedValue({ success: true } as any);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('onEscrowEvent', () => {
    it('should dispatch both email and web notifications for ESCROW_INITIALIZED', async () => {
      const payload = {
        contractId: 'C123',
        userEmail: 'client@example.com',
        userId: 'cl123',
        amount: '1500 USDC'
      };

      await EscrowHooks.onEscrowEvent(KeyEscrowEvent.ESCROW_INITIALIZED, payload);

      expect(sendEmailSpy).toHaveBeenCalledTimes(1);
      expect(sendEmailSpy).toHaveBeenCalledWith(
        'client@example.com',
        KeyEscrowEvent.ESCROW_INITIALIZED,
        expect.objectContaining({ contractId: 'C123', amount: '1500 USDC' })
      );

      expect(sendWebSpy).toHaveBeenCalledTimes(1);
      expect(sendWebSpy).toHaveBeenCalledWith(
        'cl123',
        KeyEscrowEvent.ESCROW_INITIALIZED,
        expect.objectContaining({ contractId: 'C123', amount: '1500 USDC' })
      );
    });

    it('should dispatch both email and web notifications for MILESTONE_RELEASED', async () => {
      const payload = {
        contractId: 'C456',
        userEmail: 'freelancer@example.com',
        userId: 'fl789',
        amount: '2000 USDC'
      };

      await EscrowHooks.onEscrowEvent(KeyEscrowEvent.MILESTONE_RELEASED, payload);

      expect(sendEmailSpy).toHaveBeenCalledTimes(1);
      expect(sendEmailSpy).toHaveBeenCalledWith(
        'freelancer@example.com',
        KeyEscrowEvent.MILESTONE_RELEASED,
        expect.objectContaining({ contractId: 'C456', amount: '2000 USDC' })
      );

      expect(sendWebSpy).toHaveBeenCalledTimes(1);
      expect(sendWebSpy).toHaveBeenCalledWith(
        'fl789',
        KeyEscrowEvent.MILESTONE_RELEASED,
        expect.objectContaining({ contractId: 'C456', amount: '2000 USDC' })
      );
    });

    it('should dispatch both email and web notifications for CONTRACT_COMPLETED', async () => {
      const payload = {
        contractId: 'C789',
        userEmail: 'client@example.com',
        userId: 'cl012',
        amount: '5000 USDC'
      };

      await EscrowHooks.onEscrowEvent(KeyEscrowEvent.CONTRACT_COMPLETED, payload);

      expect(sendEmailSpy).toHaveBeenCalledTimes(1);
      expect(sendEmailSpy).toHaveBeenCalledWith(
        'client@example.com',
        KeyEscrowEvent.CONTRACT_COMPLETED,
        expect.objectContaining({ contractId: 'C789', amount: '5000 USDC' })
      );

      expect(sendWebSpy).toHaveBeenCalledTimes(1);
      expect(sendWebSpy).toHaveBeenCalledWith(
        'cl012',
        KeyEscrowEvent.CONTRACT_COMPLETED,
        expect.objectContaining({ contractId: 'C789', amount: '5000 USDC' })
      );
    });
  });
});
