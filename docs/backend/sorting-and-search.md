# Sorting and Search API Documentation

## Overview
The Sorting and Search API provides secure, server-side filtering and ordering for backend resources. It is designed to be efficient, easy to use, and resistant to malicious input.

## Features
- **Keyword Search**: Case-insensitive search across multiple resource fields.
- **Secure Sorting**: Server-side ordering with strict validation of sortable fields.
- **Integration**: Easily applicable to any resource array.

## Implementation Details

### Sorting Utility (`src/utils/sorting.ts`)
The `sortItems` function takes an array of items, a sort field, an order, and a list of allowed fields.
- **Security**: It only allows sorting on fields explicitly defined in `allowedFields`.
- **Logic**: Handles string and numeric comparisons, with support for ascending and descending orders.

### Search Utility (`src/utils/search.ts`)
The `searchItems` function filters items based on a keyword query.
- **Logic**: Performs a case-insensitive `includes` check on specified fields.
- **Safety**: Gracefully handles non-string values.

## API Usage Example

### Contracts Endpoint
`GET /api/v1/contracts?search=web&sortBy=value&order=desc`

**Query Parameters:**
- `search`: A string to search for in the resource title and description.
- `sortBy`: The field to sort the results by (Allowed: `title`, `status`, `value`, `createdAt`).
- `order`: The sort direction (`asc` or `desc`). Defaults to `asc`.

## Testing
Comprehensive test suites are provided in `src/**/*.test.ts`.
- **Unit Tests**: Validate the logic of sorting and search utilities.
- **Integration Tests**: Verify the API endpoints handle query parameters correctly and return filtered/sorted results.

To run tests:
```bash
npm test -- --coverage
```
Current coverage: **100% Statements, 100% Branches, 100% Functions, 100% Lines**.
