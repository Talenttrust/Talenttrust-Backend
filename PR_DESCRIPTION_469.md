## Summary
This PR completes the contract service migration to the repository-backed implementation for issue 469.

## Changes made
- Updated the contract service to use the repository for all contract reads and writes instead of relying on in-memory state.
- Ensured contract pagination is delegated to the repository-backed cursor pagination flow.
- Added regression tests covering repository delegation for contract lookup, pagination, creation, update, and deletion.
- Cleaned up the contracts controller implementation to align with the injected service layer.

## Testing
- Added/updated unit tests for the contract service repository delegation behavior.
- Verified there are no editor-reported TypeScript errors in the affected files.

Closes #469
