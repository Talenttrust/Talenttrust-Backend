# Reputation Profile API

This document details the Reputation Profile API within the TalentTrust Backend.

## Overview

The Reputation API provides mechanisms to retrieve and update the reputation of freelancers. It uses a 1-5 rating system with comments and tracks metrics such as `score`, `jobsCompleted`, and `totalRatings`.

## Endpoints

### 1. Retrieve Freelancer Reputation

**GET** `/api/v1/reputation/:freelancerId`

Retrieves the reputation profile of the freelancer. If it doesn't exist, a default empty profile is returned.

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    "freelancerId": "fl-12345",
    "score": 4.5,
    "jobsCompleted": 10,
    "totalRatings": 15,
    "reviews": [ ... ],
    "lastUpdated": "2023-11-01T10:00:00.000Z"
  }
}
```

### 2. Update Freelancer Reputation

**PUT** `/api/v1/reputation/:freelancerId`

Adds a new review to the freelancer's profile and automatically recalculates the overall score. Optionally tracks job completion.

**Request Body:**
```json
{
  "reviewerId": "client-987",
  "rating": 5,
  "comment": "Excellent work!",
  "jobCompleted": true
}
```

**Response (200 OK):**
```json
{
  "status": "success",
  "data": {
    // Updated profile data
  }
}
```

## Security Assumptions and Threat Scenarios

- **Input Validation**: The API ensures rating values strictly fall between 1 and 5. Missing mandatory ID fields are aggressively rejected with a 400 Bad Request.
- **Data Integrity**: Average score computations are protected from division-by-zero bounds during their update cycle.
- **Current Limitation (Mock Storage)**: Since the state is in-memory for the time being, data does not persist across backend restarts. In subsequent releases, data must be securely mapped to a database or immutable ledger (Stellar/Soroban).
- **Authentication**: Currently, the routes are unprotected for testing. In production, these calls must be protected by JWT and role-based checks (e.g., verifying `reviewerId` matches the authenticated client session and that the job relationship actually exists).
