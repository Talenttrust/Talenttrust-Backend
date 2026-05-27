import { EscrowHooks } from './escrow.hooks';
import { KeyEscrowEvent } from '../types/notification.types';
import { notificationService } from '../services/notification.service';

describe('EscrowHooks', () => {
  let sendEmailSpy: jest.SpyInstance;
  let sendWebSpy: jest.SpyInstance;

  beforeEach(() => {
    sendEmailSpy = jest.spyOn(notificationService, 'sendEmail').mockResolvedValue(true);
    sendWebSpy = jest.spyOn(notificationService, 'sendWebNotification').mockResolvedValue(true);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('onEscrowEvent', () => {
    it('should dispatch both email and web notifications simultaneously', async () => {
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
  });
});
