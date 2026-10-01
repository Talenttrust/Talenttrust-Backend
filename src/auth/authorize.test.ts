import { isAllowed, setAuthorizationLogger, resetAuthorizationLogger, AuthorizationLogger } from './authorize';
import { Role, Resource, Action } from './roles';

describe('authorize state invariants', () => {
  let mockLogger: jest.Mocked<AuthorizationLogger>;

  beforeEach(() => {
    mockLogger = {
      warn: jest.fn(),
      error: jest.fn(),
    };
    setAuthorizationLogger(mockLogger);
  });

  afterEach(() => {
    resetAuthorizationLogger();
    jest.clearAllMocks();
  });

  describe('valid and allowed combinations', () => {
    it('allows admin to create users', () => {
      expect(isAllowed('admin', 'users', 'create')).toBe(true);
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('allows freelancer to read contracts', () => {
      expect(isAllowed('freelancer', 'contracts', 'read')).toBe(true);
    });

    it('allows client to create contracts', () => {
      expect(isAllowed('client', 'contracts', 'create')).toBe(true);
    });
  });

  describe('valid but forbidden combinations (matrix logic)', () => {
    it('denies freelancer from deleting users', () => {
      expect(isAllowed('freelancer', 'users', 'delete')).toBe(false);
    });

    it('denies guest from creating contracts', () => {
      expect(isAllowed('guest', 'contracts', 'create')).toBe(false);
    });
  });

  describe('boundary and invalid inputs (invariant protection)', () => {
    it('denies and logs warning for completely unknown roles', () => {
      expect(isAllowed('hacker' as Role, 'users', 'read')).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith('authorization.denied.unknown_role');
    });

    it('denies and logs warning for unknown resources', () => {
      expect(isAllowed('admin', 'passwords' as Resource, 'read')).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith('authorization.denied.unknown_resource');
    });

    it('denies and logs warning for unknown actions', () => {
      expect(isAllowed('admin', 'users', 'hack' as Action)).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith('authorization.denied.unknown_action');
    });

    it('denies missing or nullish arguments', () => {
      expect(isAllowed(null as unknown as Role, 'users', 'read')).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith('authorization.denied.invalid_input_type', expect.any(Object));

      expect(isAllowed('admin', undefined as unknown as Resource, 'read')).toBe(false);
      expect(isAllowed('admin', 'users', {} as unknown as Action)).toBe(false);
    });

    it('denies malformed inputs (arrays) without throwing', () => {
      expect(isAllowed(['admin'] as unknown as Role, 'users', 'read')).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith('authorization.denied.invalid_input_type', expect.any(Object));
    });
  });

  describe('fail-closed recovery', () => {
    it('returns false and logs error on unexpected runtime exceptions', () => {
      // We can force a throw by mutating the logger itself to throw during a known warning,
      // or we can simulate an internal failure if there was an injection point. 
      // Since it's pure, we can break the inputs to throw if they bypass type checks but the logger throws.
      mockLogger.warn.mockImplementation(() => {
        throw new Error('Simulated runtime failure');
      });

      // This will trigger a warn, which we rigged to throw, triggering the catch block
      expect(isAllowed('invalid_role' as Role, 'users', 'read')).toBe(false);
      
      expect(mockLogger.error).toHaveBeenCalledWith('authorization.error.fail_closed', {
        message: 'Simulated runtime failure',
      });
    });
  });
});
