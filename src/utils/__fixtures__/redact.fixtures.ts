/**
 * Shared test fixtures for redaction tests.
 *
 * @module utils/__fixtures__/redact
 */

/**
 * Mock secret values. These are intentionally fake and used only
 * to verify redaction behavior. Never use real credentials.
 */
export const MOCK_SECRETS = {
  bearerToken: 'Bearer fake-token-for-testing-only',
  apiKey: 'sk_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  password: 'FakePassword123!',
  cookieValue: 'session=fake-session-id; Path=/; HttpOnly',
  csrfToken: 'fake-csrf-token-abc123',
} as const;

/**
 * Mock safe (non-sensitive) values that should pass through redaction.
 */
export const MOCK_SAFE_VALUES = {
  username: 'testuser',
  email: 'test@example.com',
  userId: 'usr_12345',
  timestamp: '2024-01-15T10:30:00Z',
  isActive: true,
  count: 42,
} as const;

/**
 * Deeply nested object structure for recursive redaction tests.
 */
export const NESTED_OBJECT = {
  user: {
    profile: {
      name: 'Alice',
      email: 'alice@example.com',
      credentials: {
        password: MOCK_SECRETS.password,
        token: MOCK_SECRETS.bearerToken,
      },
    },
    preferences: {
      theme: 'dark',
      notifications: true,
    },
  },
  system: {
    apiKey: MOCK_SECRETS.apiKey,
    config: {
      timeout: 5000,
      retries: 3,
    },
  },
} as const;