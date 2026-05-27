import { SorobanService } from './soroban.service';

describe('SorobanService', () => {
  let sorobanService: SorobanService;

  beforeEach(() => {
    sorobanService = new SorobanService();
    // Spy on console.log
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should prepare escrow successfully', async () => {
    const result = await sorobanService.prepareEscrow('contract123', 100);
    expect(result).toBe(true);
  });

  it('should return escrow status', async () => {
    const status = await sorobanService.getEscrowStatus('contract123');
    expect(status).toBe('FUNDED');
  });
});
