# Escrow Contract — Fee Accounting & Payout Model

## Gross vs Net payout

When a client calls `release_milestone(amount)`, the contract does **not** pay
the freelancer the gross `amount`.  Instead it splits the milestone into a
**net payout** and a **protocol fee**:

```
fee              = floor(amount × fee_bps / 10_000)
net_to_freelancer = amount − fee
```

| Field | Tracks |
|---|---|
| `released_amount` | Sum of **net** amounts paid to the freelancer |
| `accumulated_fees` | Sum of protocol fees retained |
| `refunded_amount` | Sum of gross amounts returned to the client |
| `funded_amount` | Total gross amount deposited by the client |

## Accounting invariant

After every `release_milestone` and `refund` the following must hold:

```
released_amount + refunded_amount + accumulated_fees ≤ funded_amount
```

The contract asserts this invariant explicitly after each state mutation.  A
violation returns `Error::InvariantViolation` and the state change is rolled
back (Soroban reverts all storage writes on error).

## Why fees come out of the payout

The previous model credited the freelancer the **gross** amount and also
accrued a fee, meaning:

```
released_amount + accumulated_fees > funded_amount   ← double-counting
```

The corrected model ensures:

```
net + fee = gross milestone   ← conservation of value
```

## Fee rate bounds

| Parameter | Minimum | Maximum |
|---|---|---|
| `fee_bps` | `0` (no fee) | `5_000` (50 %) |

Initialisation fails with `Error::FeeTooHigh` if `fee_bps > 5_000`.

## Floor division

Fee arithmetic uses integer floor division.  For very small milestone amounts
the fee may round down to zero — the freelancer receives the full stroop.
This is intentional and consistent with conservative fee collection.

## TTL / storage

Contract state is stored in Soroban instance storage.  There is no TTL applied
to escrow state; it persists until the contract is decommissioned.
