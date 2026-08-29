# Contracts Data Retention

This document describes the data retention policy, storage behavior, and PII handling for Freelancer Escrow Contracts in the Talenttrust-Backend system.

## 1. What's Stored

Contracts represent agreements between clients and freelancers. The following metadata is stored in the primary SQLite `contracts` database table:
- `id` (UUID): Unique identifier for the contract
- `title` (String): The title or name of the contract
- `client_id` (String): Identifier linking to the client
- `freelancer_id` (String): Identifier linking to the freelancer
- `amount` (Number): The budget amount of the contract
- `status` (String): The current state (`draft`, `active`, `completed`, `disputed`, `cancelled`)
- `version` (Number): Used for Optimistic Concurrency Control (OCC)
- `created_at` (String): Timestamp of contract creation

*(Source: `src/repositories/contractRepository.ts` - `CreateContractInput` and `ContractRow`)*

## 2. Retention Windows and Purge Behavior

Currently, contracts are **retained indefinitely** in the main operational database.

- **Automated Purging**: There is no automated job, cron, or background task configured to expire or purge contracts. Contracts are entirely excluded from the automated `src/retention/purge.ts` lifecycle.
- **Archival**: Contracts are not integrated into the `StorageManager` archival paths (`src/retention/archival.ts`). While the retention engine defines a `DataEntityType.CONTRACT` constant (`src/retention/types.ts`), it is currently unused in production logic. 
- **Manual Deletion**: Contracts are only removed if explicitly requested via the API, which invokes `ContractsService.deleteContract()` to execute a hard `DELETE FROM contracts WHERE id = ?`.

## 3. PII Handling

The `contracts` table does not directly store traditional Personally Identifiable Information (PII) such as real names, email addresses, or physical addresses.

- The `client_id` and `freelancer_id` fields are internal UUIDs/strings. While they can be linked to user profiles containing PII, the contract record itself remains decoupled.
- **Caution**: The `title` field relies on user input and could theoretically contain unstructured PII if a user inappropriately names their contract (e.g., "Contract for John Doe"). 
- No specific PII redaction or masking (such as `maskEmail` from `src/audit/redact.ts`) is currently performed on contract data upon storage, as it is assumed to be PII-free metadata.
