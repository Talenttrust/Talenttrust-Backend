# Contract Metadata API

The Contract Metadata API provides secure CRUD operations for managing metadata associated with escrow contracts in the TalentTrust platform. This API enables storage of key-value pairs with support for different data types and sensitive data handling.

## Overview

Contract metadata allows you to store additional information about escrow contracts such as:
- Contract terms and conditions
- Project specifications
- Payment milestones
- Custom attributes
- Sensitive configuration data

## Base URL

```
https://api.talenttrust.com/api/v1
```

## Authentication

All endpoints require authentication using a Bearer token:

```
Authorization: Bearer <your-auth-token>
```

## Data Types

The API supports the following data types for metadata values:

- `string`: Text values (default)
- `number`: Numeric values
- `boolean`: True/false values
- `json`: JSON objects/arrays

## Endpoints

### Create Metadata

**POST** `/contracts/{contractId}/metadata`

Create a new metadata record for a contract.

**Request Body:**
```json
{
  "key": "milestone_description",
  "value": "First milestone: Complete project setup",
  "data_type": "string",
  "is_sensitive": false
}
```

**Parameters:**
- `contractId` (path, required): UUID of the contract
- `key` (body, required): 1-255 characters, alphanumeric + underscores + hyphens only
- `value` (body, required): 1-10000 characters
- `data_type` (body, optional): `string|number|boolean|json` (default: `string`)
- `is_sensitive` (body, optional): Boolean (default: `false`)

**Response (201):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "contract_id": "550e8400-e29b-41d4-a716-446655440001",
  "key": "milestone_description",
  "value": "First milestone: Complete project setup",
  "data_type": "string",
  "is_sensitive": false,
  "created_by": "550e8400-e29b-41d4-a716-446655440002",
  "updated_by": null,
  "created_at": "2024-01-15T10:30:00.000Z",
  "updated_at": "2024-01-15T10:30:00.000Z"
}
```

**Error Responses:**
- `400`: Validation failed
- `401`: Authentication required
- `403`: Access denied to this contract
- `404`: Contract not found
- `409`: Metadata key already exists for this contract

---

### List Metadata

**GET** `/contracts/{contractId}/metadata`

Retrieve paginated metadata records for a contract.

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page, max 100 (default: 20)
- `key` (optional): Filter by metadata key
- `data_type` (optional): Filter by data type

**Response (200):**
```json
{
  "records": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "contract_id": "550e8400-e29b-41d4-a716-446655440001",
      "key": "milestone_description",
      "value": "First milestone: Complete project setup",
      "data_type": "string",
      "is_sensitive": false,
      "created_by": "550e8400-e29b-41d4-a716-446655440002",
      "updated_by": null,
      "created_at": "2024-01-15T10:30:00.000Z",
      "updated_at": "2024-01-15T10:30:00.000Z"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

**Error Responses:**
- `400`: Invalid query parameters
- `401`: Authentication required
- `403`: Access denied to this contract

---

### Get Single Metadata

**GET** `/contracts/{contractId}/metadata/{id}`

Retrieve a specific metadata record.

**Parameters:**
- `contractId` (path, required): UUID of the contract
- `id` (path, required): UUID of the metadata record

**Response (200):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "contract_id": "550e8400-e29b-41d4-a716-446655440001",
  "key": "milestone_description",
  "value": "First milestone: Complete project setup",
  "data_type": "string",
  "is_sensitive": false,
  "created_by": "550e8400-e29b-41d4-a716-446655440002",
  "updated_by": null,
  "created_at": "2024-01-15T10:30:00.000Z",
  "updated_at": "2024-01-15T10:30:00.000Z"
}
```

**Error Responses:**
- `400`: Invalid parameters
- `401`: Authentication required
- `403`: Access denied to this contract
- `404`: Metadata not found

---

### Update Metadata

**PATCH** `/contracts/{contractId}/metadata/{id}`

Update an existing metadata record.

**Request Body:**
```json
{
  "value": "Updated milestone description",
  "is_sensitive": true
}
```

**Parameters:**
- `contractId` (path, required): UUID of the contract
- `id` (path, required): UUID of the metadata record
- `value` (body, optional): New value (1-10000 characters)
- `is_sensitive` (body, optional): Boolean sensitivity flag

**Response (200):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "contract_id": "550e8400-e29b-41d4-a716-446655440001",
  "key": "milestone_description",
  "value": "Updated milestone description",
  "data_type": "string",
  "is_sensitive": true,
  "created_by": "550e8400-e29b-41d4-a716-446655440002",
  "updated_by": "550e8400-e29b-41d4-a716-446655440002",
  "created_at": "2024-01-15T10:30:00.000Z",
  "updated_at": "2024-01-15T11:00:00.000Z"
}
```

**Error Responses:**
- `400`: Validation failed
- `401`: Authentication required
- `403`: Access denied to this contract
- `404`: Metadata not found
- `422`: Cannot update immutable fields (key, data_type)

---

### Delete Metadata

**DELETE** `/contracts/{contractId}/metadata/{id}`

Soft delete a metadata record.

**Parameters:**
- `contractId` (path, required): UUID of the contract
- `id` (path, required): UUID of the metadata record

**Response (204):** No Content

**Error Responses:**
- `400`: Invalid parameters
- `401`: Authentication required
- `403`: Access denied to this contract

## Sensitive Data Handling

When `is_sensitive` is set to `true`:

- The `value` field is masked as `***REDACTED***` for users who are not:
  - The record owner (creator)
  - An admin user

- The original value is still stored securely and accessible to authorized users

**Example masked response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "key": "api_key",
  "value": "***REDACTED***",
  "is_sensitive": true,
  "created_by": "550e8400-e29b-41d4-a716-446655440003"
}
```

## Security Considerations

### Threat Mitigations

1. **Unauthorized Access**: All endpoints require valid authentication and contract-level authorization
2. **Data Exposure**: Sensitive fields are automatically masked based on user permissions
3. **Injection Attacks**: All inputs are validated and sanitized using strict schemas
4. **Rate Limiting**: Metadata creation is rate-limited per contract (implementation recommended)
5. **Audit Trail**: All operations are logged with user IDs and timestamps

### Best Practices

1. Use meaningful, descriptive keys that follow the naming convention
2. Mark truly sensitive data (API keys, passwords, personal info) as `is_sensitive: true`
3. Use appropriate `data_type` values for proper validation and future compatibility
4. Implement client-side caching for frequently accessed metadata
5. Use pagination for contracts with large amounts of metadata

## Example Usage

### Create Contract Metadata

```bash
curl -X POST https://api.talenttrust.com/api/v1/contracts/550e8400-e29b-41d4-a716-446655440001/metadata \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "project_deadline",
    "value": "2024-03-15T23:59:59.000Z",
    "data_type": "string",
    "is_sensitive": false
  }'
```

### List with Filtering

```bash
curl -X GET "https://api.talenttrust.com/api/v1/contracts/550e8400-e29b-41d4-a716-446655440001/metadata?page=1&limit=10&data_type=string" \
  -H "Authorization: Bearer your-token"
```

### Update Metadata

```bash
curl -X PATCH https://api.talenttrust.com/api/v1/contracts/550e8400-e29b-41d4-a716-446655440001/metadata/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{
    "value": "Updated project deadline: 2024-03-20T23:59:59.000Z"
  }'
```

### Delete Metadata

```bash
curl -X DELETE https://api.talenttrust.com/api/v1/contracts/550e8400-e29b-41d4-a716-446655440001/metadata/550e8400-e29b-41d4-a716-446655440000 \
  -H "Authorization: Bearer your-token"
```

## Error Codes

| Status Code | Meaning | Description |
|-------------|---------|-------------|
| 200 | OK | Request successful |
| 201 | Created | Resource created successfully |
| 204 | No Content | Resource deleted successfully |
| 400 | Bad Request | Validation failed or invalid input |
| 401 | Unauthorized | Authentication required or invalid |
| 403 | Forbidden | Access denied to contract |
| 404 | Not Found | Contract or metadata not found |
| 409 | Conflict | Duplicate key or resource conflict |
| 422 | Unprocessable Entity | Immutable field update attempted |
| 500 | Internal Server Error | Server error occurred |
