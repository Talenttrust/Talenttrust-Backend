import {
  FEATURE_ENV_KEYS,
  getPublicRuntimeConfig,
  loadRuntimeConfig,
  parseBooleanEnv,
} from './runtime-config';

describe('parseBooleanEnv', () => {
  it('returns the default when the value is undefined', () => {
    expect(parseBooleanEnv(undefined, 'FEATURE_EXAMPLE', true)).toBe(true);
  });

  it.each([
    'true',
    'TRUE',
    '1',
    'yes',
    'YES',
    'on',
    ' On ',
  ])('accepts truthy value %s', (value) => {
    expect(parseBooleanEnv(value, 'FEATURE_EXAMPLE', false)).toBe(true);
  });

  it.each([
    'false',
    'FALSE',
    '0',
    'no',
    'NO',
    'off',
    ' Off ',
  ])('accepts falsy value %s', (value) => {
    expect(parseBooleanEnv(value, 'FEATURE_EXAMPLE', true)).toBe(false);
  });

  it('throws on an invalid boolean value', () => {
    expect(() => parseBooleanEnv('enabled', 'FEATURE_EXAMPLE', false)).toThrow(
      'Invalid boolean value for FEATURE_EXAMPLE: "enabled".',
    );
  });
});

describe('loadRuntimeConfig', () => {
  it('loads defaults that preserve current public behavior', () => {
    expect(loadRuntimeConfig({})).toEqual({
      port: 3001,
      features: {
        contractsApiEnabled: true,
        runtimeConfigEndpointEnabled: false,
      },
    });
  });

  it('uses process.env when no explicit env object is provided', () => {
    const previousPort = process.env.PORT;
    const previousContractsFlag = process.env[FEATURE_ENV_KEYS.contractsApiEnabled];
    const previousRuntimeConfigFlag =
      process.env[FEATURE_ENV_KEYS.runtimeConfigEndpointEnabled];

    process.env.PORT = '3200';
    process.env[FEATURE_ENV_KEYS.contractsApiEnabled] = 'true';
    process.env[FEATURE_ENV_KEYS.runtimeConfigEndpointEnabled] = 'off';

    try {
      expect(loadRuntimeConfig()).toEqual({
        port: 3200,
        features: {
          contractsApiEnabled: true,
          runtimeConfigEndpointEnabled: false,
        },
      });
    } finally {
      if (previousPort === undefined) {
        delete process.env.PORT;
      } else {
        process.env.PORT = previousPort;
      }

      if (previousContractsFlag === undefined) {
        delete process.env[FEATURE_ENV_KEYS.contractsApiEnabled];
      } else {
        process.env[FEATURE_ENV_KEYS.contractsApiEnabled] = previousContractsFlag;
      }

      if (previousRuntimeConfigFlag === undefined) {
        delete process.env[FEATURE_ENV_KEYS.runtimeConfigEndpointEnabled];
      } else {
        process.env[FEATURE_ENV_KEYS.runtimeConfigEndpointEnabled] = previousRuntimeConfigFlag;
      }
    }
  });

  it('parses the configured port and feature values', () => {
    expect(
      loadRuntimeConfig({
        PORT: '4100',
        [FEATURE_ENV_KEYS.contractsApiEnabled]: 'off',
        [FEATURE_ENV_KEYS.runtimeConfigEndpointEnabled]: 'yes',
      }),
    ).toEqual({
      port: 4100,
      features: {
        contractsApiEnabled: false,
        runtimeConfigEndpointEnabled: true,
      },
    });
  });

  it('fails closed when the port is invalid', () => {
    expect(() => loadRuntimeConfig({ PORT: '70000' })).toThrow(
      'Invalid PORT value "70000".',
    );
  });

  it('fails closed when a feature flag uses an unsupported value', () => {
    expect(() =>
      loadRuntimeConfig({
        [FEATURE_ENV_KEYS.runtimeConfigEndpointEnabled]: 'sometimes',
      }),
    ).toThrow(
      'Invalid boolean value for FEATURE_RUNTIME_CONFIG_ENDPOINT_ENABLED: "sometimes".',
    );
  });

  it('builds a public-safe runtime config snapshot', () => {
    expect(
      getPublicRuntimeConfig({
        port: 4100,
        features: {
          contractsApiEnabled: true,
          runtimeConfigEndpointEnabled: false,
        },
      }),
    ).toEqual({
      features: {
        contractsApiEnabled: true,
        runtimeConfigEndpointEnabled: false,
      },
    });
  });
});
