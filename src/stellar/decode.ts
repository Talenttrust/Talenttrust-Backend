export type ChainStatus = 'Created' | 'Funded' | 'Completed' | 'Disputed' | 'Resolved' | 'Cancelled';

export interface DecodedEscrow {
  id: string;
  client: string;
  freelancer: string;
  token: string;
  milestones: Array<{ index: number; amount: string; released: boolean }>;
  totalAmount: string;
  fundedAmount: string;
  releasedAmount: string;
  status: ChainStatus;
  reputationIssued: boolean;
}

export interface DecodedReputation {
  completedContracts: number;
  totalRating: number;
}

const statuses = new Set<ChainStatus>(['Created', 'Funded', 'Completed', 'Disputed', 'Resolved', 'Cancelled']);

const field = (value: Record<string, unknown>, snake: string, camel: string) => value[snake] ?? value[camel];

function integer(value: unknown, name: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error(`invalid ${name}`);
}

function status(value: unknown): ChainStatus {
  const candidate = Array.isArray(value) && value.length === 1 ? value[0] : value;
  const name = typeof candidate === 'string' ? candidate : undefined;
  if (!name || !statuses.has(name as ChainStatus)) throw new Error('invalid contract status');
  return name as ChainStatus;
}

function nativeRecord(native: unknown): Record<string, unknown> {
  if (!native || typeof native !== 'object' || Array.isArray(native)) throw new Error('invalid contract result');
  return native as Record<string, unknown>;
}

export function decodeEscrow(native: unknown): DecodedEscrow {
  const value = nativeRecord(native);
  const milestones = field(value, 'milestones', 'milestones');
  if (!Array.isArray(milestones)) throw new Error('invalid milestones');
  return {
    id: integer(field(value, 'id', 'id'), 'id').toString(),
    client: String(field(value, 'client', 'client')),
    freelancer: String(field(value, 'freelancer', 'freelancer')),
    token: String(field(value, 'token', 'token')),
    milestones: milestones.map((item, index) => {
      const milestone = nativeRecord(item);
      return {
        index,
        amount: integer(field(milestone, 'amount', 'amount'), 'milestone amount').toString(),
        released: field(milestone, 'released', 'released') === true,
      };
    }),
    totalAmount: integer(field(value, 'total_amount', 'totalAmount'), 'total amount').toString(),
    fundedAmount: integer(field(value, 'funded_amount', 'fundedAmount'), 'funded amount').toString(),
    releasedAmount: integer(field(value, 'released_amount', 'releasedAmount'), 'released amount').toString(),
    status: status(field(value, 'status', 'status')),
    reputationIssued: field(value, 'reputation_issued', 'reputationIssued') === true,
  };
}

export function decodeReputation(native: unknown): DecodedReputation {
  const value = nativeRecord(native);
  const completed = integer(field(value, 'completed_contracts', 'completedContracts'), 'completed contracts');
  const total = integer(field(value, 'total_rating', 'totalRating'), 'total rating');
  if (completed < 0n || total < 0n || completed > BigInt(Number.MAX_SAFE_INTEGER) || total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('invalid reputation');
  }
  return { completedContracts: Number(completed), totalRating: Number(total) };
}

