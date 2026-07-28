# Requirements Document

## Introduction

This feature adds a Milestones module to the TalentTrust backend (Node.js/TypeScript/Express 4.x). It covers two ordered deliverables:

1. **Task 1 — Strict input validation on milestones write endpoints**: greenfield milestones module with `POST /api/v1/milestones`, `PUT /api/v1/milestones/:id`, and `PATCH /api/v1/milestones/:id` endpoints, each enforcing strict field-level validation using a hand-rolled validator (no new runtime dependency). On any validation failure the API returns a structured 400 response with a machine-readable error code.

2. **Task 2 — Shared validation helper**: the inline validation logic from each handler is extracted into a single reusable module (`src/milestones/validation.ts`). All three handlers are updated to consume the shared helper. External behaviour is byte-for-byte identical.

## Glossary

- **Milestone**: A named checkpoint on a contract or project with a due date, an optional description, and an optional numeric target value.
- **Milestone_Router**: The Express Router that mounts milestones endpoints under `/api/v1/milestones`.
- **Milestone_Handler**: An Express request handler function for a single milestones endpoint (create, update, or partial-update).
- **Validation_Helper**: The shared module at `src/milestones/validation.ts` that exposes all milestone validation logic.
- **Error_Response**: The standardised JSON body returned for every 400 validation failure: `{ "error": { "code": string, "message": string, "fields": FieldError[] } }`.
- **FieldError**: A single item in the `fields` array: `{ "field": string, "code": string, "message": string }`.
- **Unknown_Field**: Any key in the request body that is not declared in the Milestone schema.
- **System**: The TalentTrust backend API (Express application in `src/index.ts`).

---

## Requirements

### Requirement 1: Milestone Data Model and Field Bounds

**User Story:** As a backend engineer, I want a clearly defined Milestone schema with explicit bounds for every field, so that validation rules are unambiguous and consistently applied.

#### Acceptance Criteria

1. THE System SHALL define a Milestone record with the following fields and constraints:
   - `title` — required, string, 1–200 characters (empty string is invalid)
   - `dueDate` — required, ISO 8601 date string (`YYYY-MM-DD`), must be a valid calendar date
   - `description` — optional, string, 0–1000 characters; omitted or `null` means no description
   - `targetValue` — optional, number, finite, range 0–1,000,000 (inclusive), up to 2 decimal places; omitted or `null` means no target value
   - `status` — required, string enum: one of `"pending"`, `"in_progress"`, `"completed"`
2. THE System SHALL treat `title`, `dueDate`, and `status` as required fields for the create (`POST`) and full-update (`PUT`) endpoints. WHEN any required field is absent, `null`, or `undefined`, THE System SHALL return a `400` Error_Response with `code: "REQUIRED"` for each such field, and SHALL NOT persist any changes.
3. WHEN a `PATCH` request is received, THE System SHALL explicitly treat all Milestone fields as optional and SHALL apply the same type and bounds rules to every field that is present in the request body.
4. IF a `PATCH` request contains a field that violates any type, bounds, or format rule, THEN THE System SHALL return a `400` Error_Response with the appropriate FieldError for each failing field, and SHALL NOT apply any partial update — the existing record is left unchanged.

---

### Requirement 2: Error Response Convention

**User Story:** As an API consumer, I want every validation failure to return a consistent, machine-readable JSON body, so that my client can display meaningful errors without parsing free-text messages.

#### Acceptance Criteria

1. WHEN a validation failure occurs, THE System SHALL respond with HTTP status `400`.
2. WHEN a validation failure occurs, THE System SHALL return a JSON body that conforms to the Error_Response shape and SHALL set the `Content-Type: application/json` response header:
   ```json
   {
     "error": {
       "code": "VALIDATION_ERROR",
       "message": "Request validation failed",
       "fields": [
         { "field": "<field_name>", "code": "<error_code>", "message": "<human_readable_description>" }
       ]
     }
   }
   ```
3. THE System SHALL use the following machine-readable `code` values in FieldError:
   - `REQUIRED` — required field is missing or `null`/`undefined`
   - `WRONG_TYPE` — value is present but not the expected type
   - `OUT_OF_RANGE` — numeric value is outside the declared min/max or string length exceeds declared max (including empty string for fields with a 1-character minimum)
   - `INVALID_FORMAT` — value fails a format rule (e.g., invalid ISO date, non-finite number, more than 2 decimal places)
   - `UNKNOWN_FIELD` — field name is not part of the Milestone schema
   - `INVALID_ENUM` — value is not one of the allowed enum members
4. THE System SHALL accumulate all validation errors for a single request and return them all together (not stop at the first error). A single field MAY appear more than once in the `fields` array if it has multiple independent violations.
5. WHEN a request passes all validation rules, THE System SHALL NOT include an `error` key in the response body.
6. WHEN a request body is not valid JSON or is missing a `Content-Type: application/json` header, THE System SHALL return a `400` response with `{ "error": { "code": "INVALID_REQUEST", "message": "Request body must be valid JSON" } }` (no `fields` array, since there are no parsed fields to report).

---

### Requirement 3: Create Milestone Endpoint

**User Story:** As an API consumer, I want to create a milestone via a `POST` request, so that I can record project checkpoints.

#### Acceptance Criteria

1. WHEN a `POST /api/v1/milestones` request is received with a valid body conforming to the Milestone schema, THE Milestone_Handler SHALL return HTTP `201` with a JSON body containing the created milestone record including the fields `id` (UUID v4 string, server-generated), `title`, `dueDate`, `status`, and the optional fields `description` and `targetValue` if provided.
2. WHEN a `POST /api/v1/milestones` request is received with a missing required field (`title`, `dueDate`, or `status`), THE Milestone_Handler SHALL return a `400` Error_Response containing a FieldError with `code: "REQUIRED"` for each missing field.
3. WHEN a `POST /api/v1/milestones` request is received with a field of the wrong type, THE Milestone_Handler SHALL return a `400` Error_Response containing a FieldError with `code: "WRONG_TYPE"` for each type mismatch.
4. WHEN a `POST /api/v1/milestones` request body contains one or more Unknown_Fields, THE Milestone_Handler SHALL return a `400` Error_Response containing a FieldError with `code: "UNKNOWN_FIELD"` for each extra field.
5. WHEN a `POST /api/v1/milestones` request is received with `title` shorter than 1 character or exceeding 200 characters, THE Milestone_Handler SHALL return a `400` Error_Response containing a FieldError with `code: "OUT_OF_RANGE"` for `title`.
6. WHEN a `POST /api/v1/milestones` request is received with `description` exceeding 1000 characters, THE Milestone_Handler SHALL return a `400` Error_Response containing a FieldError with `code: "OUT_OF_RANGE"` for `description`.
7. WHEN a `POST /api/v1/milestones` request is received with `targetValue` outside the range [0, 1,000,000], THE Milestone_Handler SHALL return a `400` Error_Response containing a FieldError with `code: "OUT_OF_RANGE"` for `targetValue`.
8. WHEN a `POST /api/v1/milestones` request is received with `dueDate` that is not a valid ISO 8601 date string (`YYYY-MM-DD`), THE Milestone_Handler SHALL return a `400` Error_Response containing a FieldError with `code: "INVALID_FORMAT"` for `dueDate`.
9. WHEN a `POST /api/v1/milestones` request is received with `status` that is not one of the allowed enum values (`"pending"`, `"in_progress"`, `"completed"`), THE Milestone_Handler SHALL return a `400` Error_Response containing a FieldError with `code: "INVALID_ENUM"` for `status`.
10. WHEN a `POST /api/v1/milestones` request is received with `targetValue` having more than 2 decimal places (e.g., `1.234`), THE Milestone_Handler SHALL return a `400` Error_Response containing a FieldError with `code: "INVALID_FORMAT"` for `targetValue`.
11. WHEN a `POST /api/v1/milestones` request is received with a body that is not valid JSON, THE Milestone_Handler SHALL return a `400` Error_Response with `code: "INVALID_REQUEST"` as defined in Requirement 2.6.

---

### Requirement 4: Full Update Milestone Endpoint

**User Story:** As an API consumer, I want to fully replace a milestone via a `PUT` request, so that I can update all fields at once.

#### Acceptance Criteria

1. WHEN a `PUT /api/v1/milestones/:id` request is received with a valid body and a recognised `id`, THE Milestone_Handler SHALL return HTTP `200` with a JSON body containing the fully updated milestone record, including the `id` field.
2. WHEN a `PUT /api/v1/milestones/:id` request is received with a missing required field (`title`, `dueDate`, or `status`), THE Milestone_Handler SHALL return a `400` Error_Response containing a FieldError with `code: "REQUIRED"` for each missing field.
3. WHEN a `PUT /api/v1/milestones/:id` request body contains one or more Unknown_Fields, THE Milestone_Handler SHALL return a `400` Error_Response containing a FieldError with `code: "UNKNOWN_FIELD"` for each extra field.
4. WHEN a `PUT /api/v1/milestones/:id` request is received with a field of the wrong type, THE Milestone_Handler SHALL return a `400` Error_Response containing a FieldError with `code: "WRONG_TYPE"` for each type mismatch.
5. WHEN a `PUT /api/v1/milestones/:id` request is received with any field that violates bounds or format rules, THE Milestone_Handler SHALL return a `400` Error_Response with the appropriate FieldError `code` for each failing field:
   - `title` shorter than 1 or longer than 200 characters → `OUT_OF_RANGE`
   - `description` longer than 1000 characters → `OUT_OF_RANGE`
   - `targetValue` outside [0, 1,000,000] → `OUT_OF_RANGE`
   - `targetValue` with more than 2 decimal places → `INVALID_FORMAT`
   - `dueDate` not matching `YYYY-MM-DD` or not a valid calendar date → `INVALID_FORMAT`
   - `status` not one of the allowed enum values → `INVALID_ENUM`
6. WHEN a `PUT /api/v1/milestones/:id` request is received with an `id` that does not correspond to any existing milestone, THE Milestone_Handler SHALL return HTTP `404` with a JSON body `{ "error": { "code": "NOT_FOUND", "message": "Milestone not found" } }`.

---

### Requirement 5: Partial Update Milestone Endpoint

**User Story:** As an API consumer, I want to partially update a milestone via a `PATCH` request, so that I can update individual fields without resending the full record.

#### Acceptance Criteria

1. WHEN a `PATCH /api/v1/milestones/:id` request is received with a valid partial body and a recognised `id`, THE Milestone_Handler SHALL return HTTP `200` with a JSON body containing the full milestone record reflecting all applied changes.
2. WHEN a `PATCH /api/v1/milestones/:id` request is received with an empty body (`{}`), THE Milestone_Handler SHALL return HTTP `200` with the existing milestone record unchanged (no-op).
3. WHEN a `PATCH /api/v1/milestones/:id` request body contains one or more Unknown_Fields, THE Milestone_Handler SHALL return a `400` Error_Response containing a FieldError with `code: "UNKNOWN_FIELD"` for each extra field.
4. WHEN a `PATCH /api/v1/milestones/:id` request is received with one or more present fields of the wrong type, THE Milestone_Handler SHALL return a `400` Error_Response containing a FieldError with `code: "WRONG_TYPE"` for each such field.
5. WHEN a `PATCH /api/v1/milestones/:id` request is received with a present field value that violates bounds or format rules, THE Milestone_Handler SHALL return a `400` Error_Response with the appropriate FieldError `code` for each failing field: `OUT_OF_RANGE` for length/numeric-range violations, `INVALID_FORMAT` for date/precision violations, `INVALID_ENUM` for invalid status values.
6. WHEN a `PATCH /api/v1/milestones/:id` request is received with an `id` that does not correspond to any existing milestone, THE Milestone_Handler SHALL return HTTP `404` with a JSON body `{ "error": { "code": "NOT_FOUND", "message": "Milestone not found" } }`.

---

### Requirement 6: Validation Library Selection

**User Story:** As a backend engineer, I want validation implemented without adding a new runtime dependency, so that the package footprint and supply-chain risk remain minimal.

#### Acceptance Criteria

1. THE System SHALL implement all milestone field validation using only TypeScript and Node.js built-ins (no additional packages in either `dependencies` or `devDependencies` beyond those already present in `package.json`).
2. THE System SHALL document the rationale for this no-dependency decision in `docs/decisions/milestones-validation.md` (or equivalent ADR), expressly noting that the bounded field set — five fields, six rule types — does not justify adding a schema-validation library.

---

### Requirement 7: Shared Validation Helper (Task 2)

**User Story:** As a backend engineer, I want all milestone validation logic centralised in a single module, so that rules are defined once and handler code stays free of inline validation.

#### Acceptance Criteria

1. THE System SHALL expose all milestone validation logic through a single module at `src/milestones/validation.ts`.
2. WHEN a Milestone_Handler invokes the Validation_Helper, THE Validation_Helper SHALL return either a typed success result containing the validated field values (with no type coercion beyond what validation rules enforce — values are passed through as-is once valid), or a typed failure result containing a non-empty `FieldError[]` array.
3. THE System SHALL update every Milestone_Handler to delegate all field-checking logic to the Validation_Helper. Handlers MAY retain branching on the result type (success vs. failure) but SHALL contain no field-checking logic of their own.
4. WHERE the Validation_Helper is extracted to replace inline validation in handlers, WHEN validation failures occur, THE System SHALL maintain the same Error_Response `code` values and HTTP status codes as the pre-refactor implementation. Only FieldError `message` strings MAY differ during the refactor.
5. THE System SHALL introduce no new runtime dependencies during the extraction refactor.

---

### Requirement 8: Test Coverage

**User Story:** As a backend engineer, I want comprehensive tests for all validation scenarios, so that regressions are caught automatically.

#### Acceptance Criteria

1. THE System SHALL include tests covering the following scenarios for each write endpoint:
   - Missing required field (one test per required field)
   - Wrong type for each field
   - Oversized string for `title` (>200 chars) and `description` (>1000 chars), plus empty string for `title` (violates 1-char minimum)
   - Numeric boundary values for `targetValue` (exactly 0 ✓, exactly 1,000,000 ✓, −0.01 ✗, 1,000,000.01 ✗)
   - Unknown/extra field rejection (response has `code: "UNKNOWN_FIELD"` in `fields`)
   - Valid input succeeding: POST returns HTTP 201 with the full milestone record; PUT/PATCH return HTTP 200 with the updated record
2. THE System SHALL achieve a minimum of 95% aggregate line and branch coverage for all files under `src/milestones/`.
3. WHEN the shared Validation_Helper is extracted (Task 2), THE System SHALL retain every rejection-case test from Task 1 and confirm that all previously passing tests continue to pass without modification.
4. THE System SHALL use Jest with ts-jest exclusively (already configured in `jest.config.js`) for all milestone tests.
5. THE System SHALL NOT introduce or permit alternative test frameworks (Mocha, Vitest, etc.) for files under `src/milestones/`.
