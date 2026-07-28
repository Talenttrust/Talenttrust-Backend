# Disputes API Examples

This document provides runnable HTTP/curl examples for the Disputes API endpoints.

**Authentication & Headers:**
- All endpoints require a valid JWT Bearer token passed in the `Authorization` header.
- For requests with a body (POST, PATCH), the `Content-Type: application/json` header is required.
- Replace `<YOUR_JWT_TOKEN>` with an actual token and `<DISPUTE_ID>` with an actual dispute ID.

---

## 1. List Disputes
**Endpoint:** `GET /api/v1/disputes`
**Permissions:** admin, auditor, client (ownOnly), freelancer (ownOnly)

```bash
curl -X GET "http://localhost:3000/api/v1/disputes" \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>"
```

**Expected Response (200 OK):**
```json
{
  "disputes": [],
  "total": 0
}
```

---

## 2. Get a Single Dispute
**Endpoint:** `GET /api/v1/disputes/:id`
**Permissions:** admin, auditor, client (ownOnly), freelancer (ownOnly)

```bash
curl -X GET "http://localhost:3000/api/v1/disputes/<DISPUTE_ID>" \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>"
```

**Expected Response (200 OK):**
```json
{
  "dispute": {
    "id": "<DISPUTE_ID>",
    "status": "open",
    "createdAt": "2026-07-26T22:15:00.000Z"
  }
}
```

---

## 3. Create a Dispute
**Endpoint:** `POST /api/v1/disputes`
**Permissions:** admin, client, freelancer

```bash
curl -X POST "http://localhost:3000/api/v1/disputes" \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Milestone not completed on time",
    "contractId": "contract-12345",
    "amount": 500
  }'
```

**Expected Response (201 Created):**
```json
{
  "dispute": {
    "id": "dispute-1690412345678",
    "reason": "Milestone not completed on time",
    "contractId": "contract-12345",
    "amount": 500,
    "status": "open",
    "createdAt": "2026-07-26T22:15:00.000Z"
  }
}
```

---

## 4. Update a Dispute
**Endpoint:** `PATCH /api/v1/disputes/:id`
**Permissions:** admin, client (ownOnly)

```bash
curl -X PATCH "http://localhost:3000/api/v1/disputes/<DISPUTE_ID>" \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "status": "resolved",
    "resolutionDetails": "Agreed to partial refund."
  }'
```

**Expected Response (200 OK):**
```json
{
  "dispute": {
    "id": "<DISPUTE_ID>",
    "status": "resolved",
    "resolutionDetails": "Agreed to partial refund.",
    "updatedAt": "2026-07-26T22:20:00.000Z"
  }
}
```

---

## 5. Delete a Dispute
**Endpoint:** `DELETE /api/v1/disputes/:id`
**Permissions:** admin only

```bash
curl -X DELETE "http://localhost:3000/api/v1/disputes/<DISPUTE_ID>" \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>"
```

**Expected Response (200 OK):**
```json
{
  "message": "Dispute <DISPUTE_ID> deleted successfully"
}
```
