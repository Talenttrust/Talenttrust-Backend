# Notification Service Hooks

## Overview
The Notification Service Hooks module provides a centralized way to broadcast multi-channel alerts across the TalentTrust decentralized freelancer escrow protocol. When key events happen in the escrow lifecycle (e.g., Funds Deposited, Dispute Raised), hooks are triggered to execute concurrent external delivery mechanics.

Currently, we support the following communication channels:
1. **Email Notifications** (Synchronous/Queued template dispatch)
2. **Web Push / In-App Notifications** (Persistent or ephemeral UI notifications)

## Supported Key Escrow Events
Defined in `src/types/notification.types.ts`:
- `ESCROW_INITIALIZED`
- `FUNDS_DEPOSITED`
- `MILESTONE_APPROVED`
- `DISPUTE_RAISED`
- `ESCROW_RESOLVED`
- `ESCROW_CANCELLED`

## Architecture & Integration
The entrypoint is typically `EscrowHooks.onEscrowEvent` located in the `src/hooks/escrow.hooks.ts` file. Passing the correct payload securely alerts `notificationService`.

## Security Notes
During threat modeling, the following scenarios were identified and mitigated:

1. **Information Leakage**: The transport layer gracefully catches network or authentication errors to ensure failure logs do not expose sensitive infrastructure variables (such as SMTP tokens).
2. **Email Spoofing / SSRF**: `to` addresses must conform to regex heuristics (e.g., must contain `@` at a minimum) before transport triggering to prevent injection or SSRF vectors passing to underlying gateways.
3. **IDOR on Web Notifications**: Dispatching Web Notifications requires checking that the session `userId` matches authorization domains. 
4. **Denial of Service (DoS) / Rate Limiting**: Sending alerts concurrently reduces I/O stalls, but rate limits should be integrated per destination email downstream to prevent systemic email bombing campaigns against victims.
