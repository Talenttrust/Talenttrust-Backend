import { parseSorobanEnv, setExitHandler } from './sorobanEnv';

// Valid Stellar contract Strkeys (56 chars, starts with C, base32 alphabet A-Z2-7)
const VALID_CONTRACT = 'CCJZ5DGASBWQXR5MPFCJXMBI333XE5U3FSJTNQU7RIKE3P5GN2K2WYD5';
const VALID_TOKEN    = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

const BASE_ENV = {
  NODE_ENV: 'test',
  SOROBAN_RPC_URL: 'https://rpc-futurenet.stellar.org:443',
  SOROBAN_NETWORK_PASSPHRASE: 'Test SDF Future Network ; October 2022',
};

describe('parseSorobanEnv', () => {
  describe('all values present and valid', () => {
    it('parses minimal required config', () => {
      const env = parseSorobanEnv(BASE_ENV);
      expect(env.sorobanRpcUrl).toBe('https://rpc-futurenet.stellar.org:443');
      expect(env.sorobanNetworkPassphrase).toBe('Test SDF Future Network ; October 2022');
      expect(env.sorobanEscrowContractId).toBeUndefined();
      expect(env.sorobanTokenContractId).toBeUndefined();
    });

    it('parses optional contract IDs when provided', () => {
      const env = parseSorobanEnv({
        ...BASE_ENV,
        SOROBAN_ESCROW_CONTRACT_ID: VALID_CONTRACT,
        SOROBAN_TOKEN_CONTRACT_ID: VALID_TOKEN,
      });
      expect(env.sorobanEscrowContractId).toBe(VALID_CONTRACT);
      expect(env.sorobanTokenContractId).toBe(VALID_TOKEN);
    });

    it('applies defaults when optional vars are absent', () => {
      const env = parseSorobanEnv({});
      expect(env.sorobanRpcUrl).toBe('https://rpc-futurenet.stellar.org:443');
      expect(env.sorobanNetworkPassphrase).toBe('Test SDF Future Network ; October 2022');
    });
  });

  describe('missing required values', () => {
    it('throws when SOROBAN_RPC_URL is an empty string', () => {
      expect(() =>
        parseSorobanEnv({ ...BASE_ENV, SOROBAN_RPC_URL: '' })
      ).toThrow(/SOROBAN_RPC_URL/);
    });

    it('throws when SOROBAN_NETWORK_PASSPHRASE is an empty string', () => {
      expect(() =>
        parseSorobanEnv({ ...BASE_ENV, SOROBAN_NETWORK_PASSPHRASE: '' })
      ).toThrow(/SOROBAN_NETWORK_PASSPHRASE/);
    });
  });

  describe('malformed values', () => {
    it('throws when SOROBAN_RPC_URL is not a URL', () => {
      expect(() =>
        parseSorobanEnv({ ...BASE_ENV, SOROBAN_RPC_URL: 'not-a-url' })
      ).toThrow(/SOROBAN_RPC_URL/);
    });

    it('throws when SOROBAN_RPC_URL points to an internal address (SSRF)', () => {
      expect(() =>
        parseSorobanEnv({ ...BASE_ENV, SOROBAN_RPC_URL: 'http://169.254.169.254/latest' })
      ).toThrow(/SOROBAN_RPC_URL/);
    });

    it('throws when SOROBAN_ESCROW_CONTRACT_ID has wrong length', () => {
      expect(() =>
        parseSorobanEnv({ ...BASE_ENV, SOROBAN_ESCROW_CONTRACT_ID: 'CSHORT' })
      ).toThrow(/SOROBAN_ESCROW_CONTRACT_ID/);
    });

    it('throws when SOROBAN_ESCROW_CONTRACT_ID does not start with C', () => {
      // Replace leading C with G (account key prefix)
      const bad = 'G' + VALID_CONTRACT.slice(1);
      expect(() =>
        parseSorobanEnv({ ...BASE_ENV, SOROBAN_ESCROW_CONTRACT_ID: bad })
      ).toThrow(/SOROBAN_ESCROW_CONTRACT_ID/);
    });

    it('throws when SOROBAN_ESCROW_CONTRACT_ID contains invalid base32 chars', () => {
      // Replace last char with '0' which is not in Stellar base32 alphabet
      const bad = VALID_CONTRACT.slice(0, -1) + '0';
      expect(() =>
        parseSorobanEnv({ ...BASE_ENV, SOROBAN_ESCROW_CONTRACT_ID: bad })
      ).toThrow(/SOROBAN_ESCROW_CONTRACT_ID/);
    });

    it('throws when SOROBAN_TOKEN_CONTRACT_ID is malformed', () => {
      expect(() =>
        parseSorobanEnv({ ...BASE_ENV, SOROBAN_TOKEN_CONTRACT_ID: 'not-a-contract-id' })
      ).toThrow(/SOROBAN_TOKEN_CONTRACT_ID/);
    });
  });

  describe('error message safety', () => {
    it('does not include the bad value in the error message', () => {
      const secret = 'super-secret-bad-value';
      let msg = '';
      try {
        parseSorobanEnv({ ...BASE_ENV, SOROBAN_RPC_URL: secret });
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).not.toContain(secret);
    });
  });

  describe('non-test environment (production path)', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalWorker = process.env.JEST_WORKER_ID;

    beforeEach(() => {
      // Simulate a non-test environment
      delete process.env.NODE_ENV;
      delete process.env.JEST_WORKER_ID;
    });

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalWorker !== undefined) process.env.JEST_WORKER_ID = originalWorker;
      // Restore default exit handler
      setExitHandler((code) => process.exit(code));
    });

    it('calls exit(1) and logs when validation fails outside test env', () => {
      const exitSpy = jest.fn(() => { throw new Error('process.exit called'); }) as unknown as (code: number) => never;
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      setExitHandler(exitSpy);

      expect(() =>
        parseSorobanEnv({ SOROBAN_RPC_URL: 'not-a-url', SOROBAN_NETWORK_PASSPHRASE: '' })
      ).toThrow('process.exit called');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[sorobanEnv]'));
      consoleSpy.mockRestore();
    });

    it('treats JEST_WORKER_ID as a test environment even without NODE_ENV=test', () => {
      // Restore JEST_WORKER_ID only (no NODE_ENV)
      process.env.JEST_WORKER_ID = originalWorker ?? '1';

      expect(() =>
        parseSorobanEnv({ ...BASE_ENV, SOROBAN_RPC_URL: 'bad' })
      ).toThrow(/Startup validation failed/);
    });
  });
});
