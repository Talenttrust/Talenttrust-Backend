import { EnvSecret, SecretsManager, secretsManager, initializeSecrets } from './secrets';

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
      process.env.JWT_SECRET = 'super-secret';

      initializeSecrets();

      expect(secretsManager.getValue<number>('PORT')).toBe(4000);
      expect(secretsManager.getValue('NODE_ENV')).toBe('production');
      expect(secretsManager.getValue('DATABASE_URL')).toBe('postgres://prod-db');
      expect(secretsManager.getValue('JWT_SECRET')).toBe('super-secret');
    });

    it('should use default values if env vars are missing during initialization', () => {
      // Ensure variables are cleared
      delete process.env.PORT;
      delete process.env.NODE_ENV;
      delete process.env.DATABASE_URL;
      delete process.env.JWT_SECRET;

      initializeSecrets();

      expect(secretsManager.getValue<number>('PORT')).toBe(3001);
      expect(secretsManager.getValue('NODE_ENV')).toBe('development');
      expect(secretsManager.getValue('DATABASE_URL')).toBe('postgresql://localhost:5432/talenttrust');
      expect(secretsManager.getValue('JWT_SECRET')).toBe('dev-secret-keep-it-safe');
    });
  });
});
