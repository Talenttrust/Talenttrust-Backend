# API Key Authentication

This document describes the API key authentication system implemented for TalentTrust Backend.

## Overview

API keys provide a secure way for internal services and external integrations to access the TalentTrust API without requiring user authentication. API keys are separate from JWT user authentication and can be used for service-to-service communication.

## Features

- **Secure Generation**: Cryptographically generated 32-byte hex keys
- **Hashed Storage**: Keys are hashed at rest using PBKDF2 with salt
- **Scoping**: Fine-grained permissions using resource:action format
- **Rotation**: Safe key rotation without changing the key ID
- **Expiration**: Optional expiration dates for temporary access
- **Audit Trail**: Last usage tracking for security monitoring
- **Deactivation**: Secure deactivation of compromised or unused keys

## API Key Format

API keys are 64-character hex strings:
```
abc123def456789012345678901234567890123456789012345678901234567890123456
```

## Usage

API keys should be sent in the `X-API-Key` header:
```http
GET /api/v1/contracts
X-API-Key: abc123def456789012345678901234567890123456789012345678901234567890123456
```

## Scope Format

API keys use a flexible scoping system with the following formats:

### Exact Match
```
contracts:read    # Can read contracts only
users:create       # Can create users only
```

### Wildcard Actions
```
contracts:*        # Can perform any action on contracts
*:read            # Can read any resource
```

### Full Wildcard
```
*                 # Can access everything (admin keys only)
```

## API Endpoints

### Create API Key
```http
POST /api/v1/api-keys
Authorization: Bearer <jwt-token>
Content-Type: application/json

{
  "name": "Internal Service Key",
  "scope": ["contracts:read", "contracts:create"],
  "expiresAt": "2024-12-31T23:59:59Z"
}
```

**Response:**
```json
{
  "message": "API key created successfully",
  "apiKey": "abc123...",
  "info": {
    "id": "key-id",
    "name": "Internal Service Key",
    "scope": ["contracts:read", "contracts:create"],
    "createdBy": "user-id",
    "createdAt": "2024-01-01T00:00:00Z",
    "expiresAt": "2024-12-31T23:59:59Z",
    "isActive": true
  }
}
```

### List API Keys
```http
GET /api/v1/api-keys
Authorization: Bearer <jwt-token>
```

**Response:**
```json
{
  "apiKeys": [
    {
      "id": "key-id",
      "name": "Internal Service Key",
      "scope": ["contracts:read", "contracts:create"],
      "createdAt": "2024-01-01T00:00:00Z",
      "updatedAt": "2024-01-01T00:00:00Z",
      "expiresAt": "2024-12-31T23:59:59Z",
      "lastUsedAt": "2024-01-15T10:30:00Z",
      "isActive": true
    }
  ],
  "total": 1
}
```

### Get API Key Details
```http
GET /api/v1/api-keys/:id
Authorization: Bearer <jwt-token>
```

### Rotate API Key
```http
POST /api/v1/api-keys/:id/rotate
Authorization: Bearer <jwt-token>
```

**Response:**
```json
{
  "message": "API key rotated successfully",
  "apiKey": "def456...",
  "info": {
    "id": "key-id",
    "name": "Internal Service Key",
    "scope": ["contracts:read", "contracts:create"],
    "createdBy": "user-id",
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-15T10:30:00Z",
    "expiresAt": "2024-12-31T23:59:59Z",
    "isActive": true
  }
}
```

### Deactivate API Key
```http
DELETE /api/v1/api-keys/:id
Authorization: Bearer <jwt-token>
```

**Response:**
```json
{
  "message": "API key deactivated successfully"
}
```

## Security Considerations

### Key Storage
- API keys are hashed using PBKDF2 with 10,000 iterations
- Each key has a unique 16-byte salt
- Hashes are stored in the format `salt:hash`

### Key Rotation
- Rotation generates a new key while keeping the same ID
- Old keys become invalid immediately upon rotation
- No downtime during rotation process

### Expiration
- Optional expiration dates for temporary access
- Expired keys are automatically rejected
- Expired keys are deactivated on first access attempt

### Audit Trail
- Last usage timestamp is updated on successful authentication
- Helps identify unused or suspicious keys
- Useful for security monitoring and compliance

## Best Practices

### Key Management
1. **Use descriptive names** - Clearly identify the purpose of each key
2. **Apply minimal scope** - Grant only necessary permissions
3. **Set expiration dates** - Use temporary keys when possible
4. **Rotate regularly** - Establish a rotation schedule for production keys
5. **Monitor usage** - Review last usage timestamps regularly

### Security
1. **Never expose keys** - API keys are only shown once during creation
2. **Use environment variables** - Store keys securely in production
3. **Implement rate limiting** - Protect against key abuse
4. **Monitor for anomalies** - Set up alerts for unusual usage patterns

### Integration
1. **Handle 401 errors** - Gracefully handle invalid/expired keys
2. **Implement retry logic** - Handle temporary network issues
3. **Log usage** - Track which services use which keys
4. **Use appropriate scope** - Request only necessary permissions

## Error Responses

### Authentication Errors
```json
{
  "error": "Missing X-API-Key header"
}
```

```json
{
  "error": "Invalid API key"
}
```

### Authorization Errors
```json
{
  "error": "Forbidden: insufficient API key scope",
  "required": "contracts:read",
  "provided": ["users:read"]
}
```

### Validation Errors
```json
{
  "error": "Invalid request body",
  "required": {
    "name": "string",
    "scope": "string[]"
  }
}
```

## Implementation Details

### Hashing Algorithm
- **Algorithm**: PBKDF2
- **Iterations**: 10,000
- **Salt Length**: 16 bytes (32 hex chars)
- **Key Length**: 64 bytes (128 hex chars)
- **Hash Format**: `salt:hash`

### Database Schema
```typescript
interface ApiKey {
  id: string;
  name: string;
  key_hash: string;        // salt:hash format
  scope: string[];
  created_by: string;
  created_at: Date;
  updated_at: Date;
  expires_at?: Date;
  last_used_at?: Date;
  is_active: boolean;
}
```

### Middleware Integration
```typescript
import { authenticateApiKey, requireApiKeyScope } from './auth/apiKeyMiddleware';

// API key authentication only
app.get('/api/internal', authenticateApiKey, handler);

// API key with scope validation
app.get('/api/contracts', 
  authenticateApiKey, 
  requireApiKeyScope('contracts', 'read'), 
  handler
);

// Either JWT or API key
app.get('/api/mixed', 
  authenticateEither, 
  handler
);
```

## Migration Guide

### From JWT to API Keys
1. Identify service-to-service communication
2. Create API keys with appropriate scopes
3. Update clients to use `X-API-Key` header
4. Remove JWT authentication from service accounts
5. Monitor and test the new authentication flow

### Key Rotation Process
1. Generate new key using rotation endpoint
2. Update service configuration with new key
3. Test new key functionality
4. Deploy updated configuration
5. Monitor for any authentication failures
6. Keep old key temporarily for rollback

## Troubleshooting

### Common Issues

**Key not working**
- Verify the key is copied correctly (no extra spaces)
- Check if the key has expired
- Ensure the key is still active
- Verify the required scope matches the key's scope

**Scope errors**
- Check the exact scope format required
- Ensure wildcards are used correctly
- Verify the key has the necessary permissions

**Performance issues**
- Monitor key validation time
- Consider database indexing for key lookups
- Implement caching for frequently validated keys

### Debug Information
Enable debug logging to trace authentication flow:
```typescript
// In development
console.log('API Key validation:', { keyId, scope, timestamp });
```

## Support

For questions or issues with API key authentication:
1. Check this documentation first
2. Review the implementation examples
3. Check the test files for usage patterns
4. Review error messages for specific issues
5. Contact the development team with detailed error information
