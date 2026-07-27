import { EnvSecret, RotatingSecret, SecretsManager, secretsManager, initializeSecrets } from './secrets';

describe('Secrets Management', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    secretsManager.clear();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('EnvSecret', () => {
    it('should load a value from process.env', () => {
      process.env.TEST_KEY = 'test-value';
      const secret = new EnvSecret('TEST_KEY');
      expect(secret.get()).toBe('test-value');
    });

    it('should use a default value if the key is missing', () => {
      const secret = new EnvSecret('MISSING_KEY', 'default-value');
      expect(secret.get()).toBe('default-value');
    });

    it('should throw an error if the key is missing and no default is provided', () => {
      expect(() => new EnvSecret('MISSING_KEY')).toThrow('Missing required secret "MISSING_KEY"');
    });

    it('should transform a value correctly', () => {
      process.env.PORT = '8080';
      const secret = new EnvSecret<number>('PORT', 3000, (v) => parseInt(v, 10));
      expect(secret.get()).toBe(8080);
    });

    it('should throw an error if the transform function fails', () => {
      process.env.PORT = 'invalid';
      expect(() => new EnvSecret<number>('PORT', 3000, (v) => {
        const p = parseInt(v, 10);
        if (isNaN(p)) throw new Error('Not a number');
        return p;
      })).toThrow('Failed to transform secret "PORT": Not a number');
    });

    it('should refresh the secret value when refresh() is called', async () => {
      process.env.ROTATING_SECRET = 'version1';
      const secret = new EnvSecret('ROTATING_SECRET');
      expect(secret.get()).toBe('version1');

      process.env.ROTATING_SECRET = 'version2';
      await secret.refresh();
      expect(secret.get()).toBe('version2');
    });
  });

  describe('EnvSecret with requireStrongInProd', () => {
    it('should still use the default in development', () => {
      process.env.NODE_ENV = 'development';
      delete process.env.STRONG_KEY;

      const secret = new EnvSecret('STRONG_KEY', 'dev-default', undefined, {
        requireStrongInProd: true,
        minLength: 32,
      });

      expect(secret.get()).toBe('dev-default');
    });

    it('should still use the default in test', () => {
      process.env.NODE_ENV = 'test';
      delete process.env.STRONG_KEY;

      const secret = new EnvSecret('STRONG_KEY', 'dev-default', undefined, {
        requireStrongInProd: true,
        minLength: 32,
      });

      expect(secret.get()).toBe('dev-default');
    });

    it('should throw instead of using the default in production', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.STRONG_KEY;

      expect(
        () =>
          new EnvSecret('STRONG_KEY', 'dev-default', undefined, {
            requireStrongInProd: true,
            minLength: 32,
          }),
      ).toThrow('Missing required secret "STRONG_KEY"');
    });

    it('should reject a value shorter than minLength in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.STRONG_KEY = 'short';

      expect(
        () =>
          new EnvSecret('STRONG_KEY', undefined, undefined, {
            requireStrongInProd: true,
            minLength: 32,
          }),
      ).toThrow('must be at least 32 characters');
    });

    it('should accept a value that meets minLength in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.STRONG_KEY = 'x'.repeat(32);

      const secret = new EnvSecret('STRONG_KEY', undefined, undefined, {
        requireStrongInProd: true,
        minLength: 32,
      });

      expect(secret.get()).toBe('x'.repeat(32));
    });

    it('should not enforce minLength in production when requireStrongInProd is false', () => {
      process.env.NODE_ENV = 'production';
      process.env.SHORT_OK_KEY = 'short';

      const secret = new EnvSecret('SHORT_OK_KEY');
      expect(secret.get()).toBe('short');
    });
  });

  describe('RotatingSecret', () => {
    it('should initialize with the provider value and return it synchronously', async () => {
      let providerCalled = false;
      const provider = async () => {
        providerCalled = true;
        return 'initial-secret';
      };

      const secret = new RotatingSecret({ provider, name: 'TEST_ROTATING' });
      await secret.refresh();

      expect(providerCalled).toBe(true);
      expect(secret.get()).toBe('initial-secret');
    });

    it('should update the cached value on refresh', async () => {
      const values = ['v1', 'v2'];
      const provider = jest.fn(async () => values.shift() ?? 'v2');
      const secret = new RotatingSecret({ provider, name: 'REFRESH_SECRET' });

      await secret.refresh();
      expect(secret.get()).toBe('v1');

      await secret.refresh();
      expect(secret.get()).toBe('v2');
      expect(provider).toHaveBeenCalledTimes(2);
    });

    it('should retain the prior value when refresh fails', async () => {
      let callCount = 0;
      const provider = jest.fn(async () => {
        callCount += 1;
        if (callCount === 1) return 'current-value';
        throw new Error('provider unavailable');
      });
      const secret = new RotatingSecret({ provider, name: 'FAILOVER_SECRET' });

      await secret.refresh();
      expect(secret.get()).toBe('current-value');

      await expect(secret.refresh()).resolves.toBeUndefined();
      expect(secret.get()).toBe('current-value');
    });
  });

  describe('SecretsManager', () => {
    it('should register and retrieve a secret', () => {
      const manager = new SecretsManager();
      const secret = new EnvSecret('TEST_KEY', 'test-value');
      manager.register('mySecret', secret);

      expect(manager.get('mySecret')).toBe(secret);
      expect(manager.getValue('mySecret')).toBe('test-value');
    });

    it('should throw when registering a secret name that already exists', () => {
      const manager = new SecretsManager();
      const secret = new EnvSecret('TEST_KEY', 'test-value');
      manager.register('mySecret', secret);

      expect(() => manager.register('mySecret', secret)).toThrow('Secret "mySecret" is already registered');
    });

    it('should throw when getting a non-existent secret', () => {
      const manager = new SecretsManager();
      expect(() => manager.get('nonExistent')).toThrow('Secret "nonExistent" not found');
    });

    it('should refresh all registered secrets', async () => {
      const manager = new SecretsManager();
      process.env.S1 = 'v1';
      process.env.S2 = 'v2';

      const secret1 = new EnvSecret('S1');
      const secret2 = new EnvSecret('S2');

      manager.register('s1', secret1);
      manager.register('s2', secret2);

      process.env.S1 = 'v1-updated';
      process.env.S2 = 'v2-updated';

      await manager.refreshAll();

      expect(manager.getValue('s1')).toBe('v1-updated');
      expect(manager.getValue('s2')).toBe('v2-updated');
    });
  });

  describe('initializeSecrets', () => {
    it('should register core application secrets', () => {
      process.env.PORT = '4000';
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgres://prod-db';
      process.env.JWT_SECRET = 'a'.repeat(32); // meets the 32-char minimum enforced in production

      initializeSecrets();

      expect(secretsManager.getValue<number>('PORT')).toBe(4000);
      expect(secretsManager.getValue('NODE_ENV')).toBe('production');
      expect(secretsManager.getValue('DATABASE_URL')).toBe('postgres://prod-db');
      expect(secretsManager.getValue('JWT_SECRET')).toBe('a'.repeat(32));
    });

    it('should use default values if env vars are missing during initialization in development', () => {
      delete process.env.PORT;
      process.env.NODE_ENV = 'development';
      delete process.env.DATABASE_URL;
      delete process.env.JWT_SECRET;

      initializeSecrets();

      expect(secretsManager.getValue<number>('PORT')).toBe(3001);
      expect(secretsManager.getValue('NODE_ENV')).toBe('development');
      expect(secretsManager.getValue('DATABASE_URL')).toBe('postgresql://localhost:5432/talenttrust');
      expect(secretsManager.getValue('JWT_SECRET')).toBe('dev-secret-keep-it-safe');
    });

    it('should throw at boot if JWT_SECRET is missing in production', () => {
      delete process.env.JWT_SECRET;
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgres://prod-db';

      expect(() => initializeSecrets()).toThrow('Missing required secret "JWT_SECRET"');
    });

    it('should throw at boot if DATABASE_URL is missing in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'a'.repeat(32);
      delete process.env.DATABASE_URL;

      expect(() => initializeSecrets()).toThrow('Missing required secret "DATABASE_URL"');
    });

    it('should reject the known weak JWT_SECRET literal even if explicitly set in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgres://prod-db';
      process.env.JWT_SECRET = 'dev-secret-keep-it-safe';

      expect(() => initializeSecrets()).toThrow('known weak/placeholder value');
    });

    it('should reject a JWT_SECRET shorter than 32 characters in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgres://prod-db';
      process.env.JWT_SECRET = 'too-short';

      expect(() => initializeSecrets()).toThrow('must be at least 32 characters');
    });

    it('should reject the known weak DATABASE_URL literal even if explicitly set in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'a'.repeat(32);
      process.env.DATABASE_URL = 'postgresql://localhost:5432/talenttrust';

      expect(() => initializeSecrets()).toThrow('known weak/placeholder value');
    });

    it('should allow the dev-only defaults in test environment too', () => {
      process.env.NODE_ENV = 'test';
      delete process.env.DATABASE_URL;
      delete process.env.JWT_SECRET;

      expect(() => initializeSecrets()).not.toThrow();
      expect(secretsManager.getValue('JWT_SECRET')).toBe('dev-secret-keep-it-safe');
      expect(secretsManager.getValue('DATABASE_URL')).toBe('postgresql://localhost:5432/talenttrust');
    });
  });
});