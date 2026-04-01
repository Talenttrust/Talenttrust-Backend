# Module Breakdown

Based on the application's domain (freelancer escrow, Soroban integration), the backend is organized into the following core modules:

## Contracts Module (`src/modules/contracts/`)
- **Responsibilities:** 
  - Manage off-chain metadata for escrow contracts.
  - Synchronize state with Soroban smart contracts.
- **Dependencies:** 
  - Depends on `SorobanService` for on-chain state queries.

## Reputation Module (`src/modules/reputation/`)
- **Responsibilities:** 
  - Track and calculate user/freelancer reputation scores based on completed contracts and reviews.
- **Dependencies:** 
  - Relies on Contract data to verify completed work.

## Soroban Integration Module (`src/services/soroban.service.ts`)
- **Responsibilities:** 
  - Bridge the backend with the Stellar network.
  - Read contract states, listen for events, and optionally submit transactions securely.
