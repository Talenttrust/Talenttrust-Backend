# Contract Metadata Module

The Contract Metadata module provides CRUD operations for managing key-value pairs associated with contracts. It supports pagination, filtering, sensitive data masking, and secure access controls.

## Base Path
`POST /api/v1/contracts/:contractId/metadata`
`GET /api/v1/contracts/:contractId/metadata`

## Access Policy
- **Admins**: Full access (view, create, update, delete) to metadata for any contract. Can see sensitive values unmasked.
- **Contract Owners**: Full access to metadata for contracts they created. Can see sensitive values unmasked.
- **Others**: No access (403 Forbidden).

## Data Schema

### Contract Metadata
| Field | Type | Description |
|-------|------|-------------|
| id | UUID | Unique identifier for the metadata record |
| contract_id | UUID | Reference to the associated contract |
| key | string | Unique key within the contract scope (alphanumeric, underscores, hyphens) |
| value | string | Metadata value (masked if sensitive and viewed by non-owner/non-admin) |
| data_type | enum | Type of data: `string`, `number`, `boolean`, `json` |
| is_sensitive | boolean | If true, the value is masked in responses for unauthorized viewers |
| created_by | UUID | ID of the user who created the record |
| updated_by | UUID | ID of the user who last updated the record |
| created_at | DateTime | Timestamp of creation |
| updated_at | DateTime | Timestamp of last update |

## API Endpoints

### 1. Create Metadata
`POST /api/v1/contracts/:contractId/metadata`

**Body:**
```json
{
  "key": "example-key",
  "value": "example-value",
  "data_type": "string",
  "is_sensitive": false
}
```

**Responses:**
- `201 Created`: Metadata created successfully.
- `400 Bad Request`: Validation failed or contract not found.
- `409 Conflict`: Metadata key already exists for this contract.

### 2. List Metadata
`GET /api/v1/contracts/:contractId/metadata`

**Query Parameters:**
- `page`: Page number (default: 1)
- `limit`: Records per page (default: 20, max: 100)
- `key`: Filter by exact key
- `data_type`: Filter by data type

**Response:**
- `200 OK`: Returns a paginated list of metadata records.

### 3. Get Metadata by ID
`GET /api/v1/contracts/:contractId/metadata/:id`

**Response:**
- `200 OK`: Returns the single metadata record.
- `400 Bad Request`: Metadata not found.

### 4. Update Metadata
`PATCH /api/v1/contracts/:contractId/metadata/:id`

**Body:**
```json
{
  "value": "new-value",
  "is_sensitive": true
}
```
*Note: `key` and `data_type` are immutable.*

**Responses:**
- `200 OK`: Metadata updated successfully.
- `400 Bad Request`: Metadata not found or attempt to update immutable fields.

### 5. Delete Metadata
`DELETE /api/v1/contracts/:contractId/metadata/:id`

**Response:**
- `204 No Content`: Metadata deleted successfully (idempotent).
