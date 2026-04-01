# Soroban RPC Integration Service

The `SorobanRpcService` provides a clean interface for the TalentTrust backend to interact with the Soroban network (Stellar). It abstracts away the raw setup of the `@stellar/stellar-sdk` RPC server and exposes the primary functions needed for our smart contract interactions.

## Configuration

The service leverages environment variables loaded via `src/config/index.ts`. 

- `SOROBAN_RPC_URL`: The URL of the Soroban RPC endpoint (default: `https://rpc-futurenet.stellar.org:443`).
- `SOROBAN_NETWORK_PASSPHRASE`: The network passphrase (default: `Test SDF Future Network ; October 2022`).

## Usage

You can import the instantiated service directly:

```typescript
import { sorobanRpcService } from '../index'; // or adjust path

// 1. Reading Contract Data
const contractId = 'C...';
const key = StellarSdk.xdr.ScVal.scvSymbol('MyKey');
const data = await sorobanRpcService.getContractData(contractId, key);

// 2. Simulating a Transaction
const simResult = await sorobanRpcService.simulateTransaction(transaction);

// 3. Submitting a Transaction
const sendResponse = await sorobanRpcService.sendTransaction(signedTransaction);

// 4. Polling for Transaction Status
const status = await sorobanRpcService.getTransactionStatus(sendResponse.hash);
if (status.status === 'SUCCESS') {
    // Transaction merged into the ledger
}
```

## Testing

The service has comprehensive unit tests mocking the `@stellar/stellar-sdk` RPC interactions. Run the tests using:

```bash
npm run test
# OR with coverage
npm run test -- --coverage
```
