export const escrowErrors = {
  1: 'AlreadyInitialized',
  2: 'NotInitialized',
  3: 'Unauthorized',
  4: 'Paused',
  5: 'ContractNotFound',
  6: 'InvalidParties',
  7: 'InvalidMilestones',
  8: 'InvalidAmount',
  9: 'OverFunded',
  10: 'InvalidStatus',
  11: 'MilestoneNotFound',
  12: 'MilestoneAlreadyReleased',
  13: 'InsufficientFunds',
  14: 'InvalidSplit',
  15: 'InvalidRating',
  16: 'ReputationAlreadyIssued',
} as const;

export type EscrowErrorCode = keyof typeof escrowErrors;

export function contractErrorFromMessage(message: string) {
  const match = message.match(/Error\(Contract,\s*#?(\d+)\)/i);
  if (!match) return undefined;

  const code = Number(match[1]) as EscrowErrorCode;
  const name = escrowErrors[code];
  return name ? { name, code } : undefined;
}