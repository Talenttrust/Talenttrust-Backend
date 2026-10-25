/**
 * Decode Soroban contract events into typed domain events.
 */

import { xdr, scValToNative } from '@stellar/stellar-sdk';
import { EscrowEvent, EventMetadata, IndexedEvent } from './types';

function decodeU64Topic(topic: xdr.ScVal): string {
  const val = scValToNative(topic);
  if (typeof val === 'bigint') {
    return val.toString();
  }
  if (typeof val === 'number') {
    return val.toString();
  }
  throw new Error(`Expected u64 topic, got ${typeof val}`);
}

function decodeStringTopic(topic: xdr.ScVal): string {
  const val = scValToNative(topic);
  if (typeof val === 'string') {
    return val;
  }
  throw new Error(`Expected string topic, got ${typeof val}`);
}

function decodeAmount(value: xdr.ScVal): string {
  const val = scValToNative(value);
  if (typeof val === 'bigint') {
    return val.toString();
  }
  if (typeof val === 'number') {
    return val.toString();
  }
  throw new Error(`Expected amount (u128/i128), got ${typeof val}`);
}

function decodeBoolean(value: xdr.ScVal): boolean {
  const val = scValToNative(value);
  if (typeof val === 'boolean') {
    return val;
  }
  throw new Error(`Expected boolean, got ${typeof val}`);
}

function decodeRating(value: xdr.ScVal): number {
  const val = scValToNative(value);
  if (typeof val === 'number') {
    return val;
  }
  if (typeof val === 'bigint') {
    return Number(val);
  }
  throw new Error(`Expected rating (u32), got ${typeof val}`);
}

function decodeAddress(value: xdr.ScVal): string {
  const val = scValToNative(value);
  if (typeof val === 'string') {
    return val;
  }
  throw new Error(`Expected address (string), got ${typeof val}`);
}

export function decodeEvent(raw: {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  topic: xdr.ScVal[];
  value: xdr.ScVal;
}): IndexedEvent {
  const metadata: EventMetadata = {
    id: raw.id,
    ledger: raw.ledger,
    ledgerClosedAt: raw.ledgerClosedAt,
    txHash: raw.txHash,
  };

  const topics = raw.topic;
  const value = raw.value;

  if (topics.length === 0) {
    return {
      ...metadata,
      event: {
        type: 'Unknown',
        data: {
          topics: [],
          value: valueToBase64(value),
        },
      },
    };
  }

  const eventType = decodeStringTopic(topics[0]);

  try {
    switch (eventType) {
      case 'created':
        if (topics.length < 4) {
          throw new Error('created event requires 4 topics');
        }
        return {
          ...metadata,
          event: {
            type: 'Created',
            data: {
              escrowId: decodeU64Topic(topics[1]),
              client: decodeAddress(topics[2]),
              freelancer: decodeAddress(topics[3]),
              total: decodeAmount(value),
            },
          },
        };

      case 'deposit':
        if (topics.length < 2) {
          throw new Error('deposit event requires 2 topics');
        }
        return {
          ...metadata,
          event: {
            type: 'Deposit',
            data: {
              escrowId: decodeU64Topic(topics[1]),
              amount: decodeAmount(value),
            },
          },
        };

      case 'release':
        if (topics.length < 3) {
          throw new Error('release event requires 3 topics');
        }
        return {
          ...metadata,
          event: {
            type: 'Release',
            data: {
              escrowId: decodeU64Topic(topics[1]),
              index: Number(decodeU64Topic(topics[2])),
              amount: decodeAmount(value),
            },
          },
        };

      case 'dispute':
        if (topics.length < 2) {
          throw new Error('dispute event requires 2 topics');
        }
        return {
          ...metadata,
          event: {
            type: 'Dispute',
            data: {
              escrowId: decodeU64Topic(topics[1]),
              caller: decodeAddress(topics[2]),
            },
          },
        };

      case 'resolved':
        if (topics.length < 2) {
          throw new Error('resolved event requires 2 topics');
        }
        return {
          ...metadata,
          event: {
            type: 'Resolved',
            data: {
              escrowId: decodeU64Topic(topics[1]),
              toFreelancer: decodeAmount(value),
              toClient: '0',
            },
          },
        };

      case 'cancel':
        if (topics.length < 2) {
          throw new Error('cancel event requires 2 topics');
        }
        return {
          ...metadata,
          event: {
            type: 'Cancel',
            data: {
              escrowId: decodeU64Topic(topics[1]),
              refund: decodeAmount(value),
            },
          },
        };

      case 'rep':
        if (topics.length < 3) {
          throw new Error('rep event requires 3 topics');
        }
        return {
          ...metadata,
          event: {
            type: 'Reputation',
            data: {
              escrowId: decodeU64Topic(topics[1]),
              freelancer: decodeAddress(topics[2]),
              rating: decodeRating(value),
            },
          },
        };

      case 'paused':
        return {
          ...metadata,
          event: {
            type: 'Paused',
            data: {
              paused: decodeBoolean(value),
            },
          },
        };

      case 'init':
        return {
          ...metadata,
          event: {
            type: 'Init',
            data: {
              admin: decodeAddress(value),
            },
          },
        };

      default:
        return {
          ...metadata,
          event: {
            type: 'Unknown',
            data: {
              topics: topics.map((t) => decodeStringTopic(t)),
              value: valueToBase64(value),
            },
          },
        };
    }
  } catch (err) {
    return {
      ...metadata,
      event: {
        type: 'Unknown',
        data: {
          topics: topics.map((t) => {
            try {
              return decodeStringTopic(t);
            } catch {
              return '<decode-error>';
            }
          }),
          value: valueToBase64(value),
        },
      },
    };
  }
}

function valueToBase64(val: xdr.ScVal): string {
  return val.toXDR('base64');
}
