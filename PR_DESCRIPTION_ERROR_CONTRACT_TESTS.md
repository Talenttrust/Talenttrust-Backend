# Add API Contract Tests for Error Envelope Stability

## Summary

This PR introduces comprehensive contract tests that assert the API error envelope shape and error codes remain stable, preventing accidental breaking changes for clients.

## 🎯 Problem Solved

Previously, the API lacked contract tests to ensure error response consistency. This created risks where:
- Error response structures could change without detection
- Error codes could be modified unexpectedly  
- Client integrations could break due to response format changes
- Request ID correlation might be inconsistent

## ✅ Solution Implemented

Added comprehensive contract tests in `src/__tests__/error-envelope-contract.test.ts` that validate:

### Error Envelope Contracts
- **Validation Errors (400)**: Ensures Zod validation errors maintain consistent structure
- **Not Found Errors (404)**: Validates 404 response format remains stable
- **Dependency Unavailable (503)**: Tests external service failure response structure
- **Internal Server Errors (500)**: Ensures internal errors don't leak sensitive information

### Stability Guarantees
- **Error Code Consistency**: Validates error codes like `not_found`, `unauthorized`, `internal_error` remain stable
- **Response Structure**: Enforces exact JSON envelope shapes
- **Header Contracts**: Ensures proper `content-type` and `x-request-id` headers

### Security & Reliability
- **Information Disclosure Prevention**: Validates no stack traces or internal details leak
- **Request ID Propagation**: Ensures correlation IDs are properly handled
- **Deterministic Testing**: All tests are CI-friendly and reliable

## 🧪 Test Coverage

```typescript
// Validation Error Contract
{
  status: 'error',
  message: 'Validation failed', 
  errors: Array<ValidationIssue>
}

// AppError Contract  
{
  error: {
    code: string,           // e.g., 'not_found', 'dependency_unavailable'
    message: string,
    requestId: string
  }
}

// 404 Error Contract
{
  error: 'Not Found'
}
```

## 🔒 Security Benefits

- **Prevents Information Disclosure**: Tests ensure error responses never leak stack traces
- **Consistent Error Handling**: Validates all error paths use secure response formats
- **Request Correlation**: Ensures proper request ID handling for debugging

## 📊 CI Integration

Tests are designed to run in CI environments:
- Uses Jest with TypeScript support
- No external dependencies required
- Deterministic and fast execution
- Proper coverage reporting included

## 🔄 Migration Impact

**Breaking Changes**: None - this is additive test coverage only

**Dependencies**: 
- Fixed `@types/pino` version compatibility issue in package.json
- No new runtime dependencies introduced

## 🧪 Verification

To verify the implementation:

```bash
# Run the specific contract tests
npm test src/__tests__/error-envelope-contract.test.ts

# Run full test suite with coverage
npm run test:ci
```

## 📋 Checklist

- [x] Tests cover validation error envelope (400)
- [x] Tests cover not found error envelope (404) 
- [x] Tests cover dependency unavailable error envelope (503)
- [x] Tests cover internal error envelope (500)
- [x] Error code stability validation
- [x] Response header contract validation
- [x] Security validation (no information leakage)
- [x] CI-friendly deterministic tests
- [x] Proper documentation and comments

## 🔗 Related Issues

Closes: Add contract tests asserting the API error envelope shape and error codes remain stable

## 📝 Additional Notes

These tests serve as a safety net for future development by ensuring any changes to error handling maintain backward compatibility with existing client integrations. The contract tests will fail immediately if any breaking changes are introduced to error response formats.

The implementation follows the existing codebase patterns and integrates seamlessly with the current Jest testing infrastructure.
