# Data Flow

The standard request lifecycle (e.g., fetching or updating a contract) follows this step-by-step flow:

1. **Client Request:** 
   A request hits an endpoint (e.g., `GET /api/v1/contracts`).

2. **Middleware (Validation/Auth):** 
   - Global middleware parses JSON (`express.json()`) and adds security headers (`helmet()`).
   - Route-specific middleware (`validateSchema`) validates the request payload structure.

3. **Controller (`ContractsController`):** 
   - Receives the validated request.
   - Extracts parameters (e.g., contract ID).
   - Calls the corresponding Service method.

4. **Service/Business Logic (`ContractsService`):**
   - Executes business rules.
   - May call the Database (for metadata) and the `SorobanService` (to fetch on-chain state).
   - Aggregates the results.

5. **Response:** 
   - The Controller receives the aggregated data from the Service.
   - Formats the HTTP response and sends it back to the client.

## Integration Points
- **Stellar/Soroban Network:** Interaction via Stellar SDK/Soroban RPC. Reads smart contract states and events.
- **Authentication Provider:** Signature verification to authenticate users based on their Stellar keypairs.
