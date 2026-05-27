# Secrets Handling Policy

## Overview

The TalentTrust Backend uses a structured and secure approach to handling secrets and configuration. This ensures that sensitive information is never hardcoded, is easily rotatable, and can be managed across different environments (Development, Staging, Production).

## Core Concepts

### 1. `Secret<T>` Interface

Defined in `src/config/secrets.ts`, the `Secret` interface provides a unified way to interact with sensitive data:

```typescript
export interface Secret<T> {
  get(): T;
  refresh(): Promise<void>;
}
```

- `get()`: Returns the current value of the secret.
- `refresh()`: Updates the secret from its source. This is crucial for supporting secret rotation without restarting the application.

### 2. `EnvSecret` Implementation

Currently, secrets are primarily loaded from environment variables using the `dotenv` library.

```typescript
new EnvSecret<number>('PORT', 3001, (v) => parseInt(v, 10));
```

- Supports default values for development.
- Supports type transformation (e.g., string to number).
- Throws clear errors if required secrets are missing.

### 3. `SecretsManager`

A central registry for all application secrets.

```typescript
import { secretsManager } from './config/secrets';

const dbUrl = secretsManager.getValue<string>('DATABASE_URL');
```

## Security Best Practices

1. **No Hardcoded Secrets**: All sensitive values (API keys, database URLs, JWT secrets) must be loaded via `SecretsManager`.
2. **Rotation Ready**: Use the `refresh()` or `refreshAll()` methods to update secrets from the source (e.g., if a secret is updated in AWS Secrets Manager or Vault).
3. **Environment Separation**: Use `.env` files for local development (ignored by Git) and environment variables in production.
4. **Validation**: The `EnvSecret` class validates that required secrets are present at startup, failing early if the configuration is invalid.

## Security Assumptions and Threat Scenarios

- **Assumption: Environment Security**: It is assumed that the environment where the backend is deployed (e.g., Kubernetes, Heroku, AWS Lambda) is secure and that environment variables are not accessible to unauthorized users.
- **Threat: Secret Leakage via Logs**: The `SecretsManager` does not automatically mask secrets in logs. Developers must ensure they do not log sensitive values retrieved from `SecretsManager`.
- **Threat: Weak Default Secrets**: Default values provided for development (e.g., `dev-secret-keep-it-safe`) must never be used in production. The `EnvSecret` class will throw an error if a required secret is missing in an environment where no default is provided.
- **Threat: Unauthorized Access to .env**: Local development `.env` files must be included in `.gitignore` to prevent accidental commits to the repository.

## Adding a New Secret

1. Open `src/config/secrets.ts`.
2. In the `initializeSecrets()` function, register the new secret:

```typescript
secretsManager.register('MY_NEW_SECRET', new EnvSecret('MY_NEW_SECRET', 'optional-default'));
```

3. Access the secret in your application:

```typescript
import { secretsManager } from '../config/secrets';
const secretValue = secretsManager.getValue('MY_NEW_SECRET');
```

## Testing

Comprehensive tests are located in `src/config/secrets.test.ts`. These tests cover:
- Successful loading from environment variables.
- Usage of default values.
- Error handling for missing required secrets.
- Type transformation logic.
- Secret rotation/refreshing.
- `SecretsManager` registration and retrieval.
