/**
 * Tests for event decoder.
 */

import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { decodeEvent } from '../src/indexer/decode';

describe('decodeEvent', () => {
  it('decodes a created event', () => {
    const symbol = xdr.ScVal.scvSymbol('created');
    const u64 = xdr.ScVal.scvU64(xdr.Uint64.fromString('1'));
    const address1 = xdr.ScVal.scvString('GCLIENTDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const address2 = xdr.ScVal.scvString('GFREELANCERDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const amount = nativeToScVal(1000n, { type: 'u128' });

    const decoded = decodeEvent({
      id: 'test-id-1',
      ledger: 100,
      ledgerClosedAt: '2024-01-01T00:00:00Z',
      txHash: 'abcd',
      topic: [symbol, u64, address1, address2],
      value: amount,
    });

    expect(decoded.event.type).toBe('Created');
    if (decoded.event.type === 'Created') {
      expect(decoded.event.data.escrowId).toBe('1');
      expect(decoded.event.data.client).toBe('GCLIENTDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      expect(decoded.event.data.freelancer).toBe('GFREELANCERDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      expect(decoded.event.data.total).toBe('1000');
    }
  });

  it('decodes a deposit event', () => {
    const symbol = xdr.ScVal.scvSymbol('deposit');
    const u64 = xdr.ScVal.scvU64(xdr.Uint64.fromString('1'));
    const amount = nativeToScVal(500n, { type: 'u128' });

    const decoded = decodeEvent({
      id: 'test-id-2',
      ledger: 101,
      ledgerClosedAt: '2024-01-01T00:01:00Z',
      txHash: 'efgh',
      topic: [symbol, u64],
      value: amount,
    });

    expect(decoded.event.type).toBe('Deposit');
    if (decoded.event.type === 'Deposit') {
      expect(decoded.event.data.escrowId).toBe('1');
      expect(decoded.event.data.amount).toBe('500');
    }
  });

  it('decodes a release event', () => {
    const symbol = xdr.ScVal.scvSymbol('release');
    const escrowId = xdr.ScVal.scvU64(xdr.Uint64.fromString('1'));
    const index = xdr.ScVal.scvU64(xdr.Uint64.fromString('0'));
    const amount = nativeToScVal(250n, { type: 'u128' });

    const decoded = decodeEvent({
      id: 'test-id-3',
      ledger: 102,
      ledgerClosedAt: '2024-01-01T00:02:00Z',
      txHash: 'ijkl',
      topic: [symbol, escrowId, index],
      value: amount,
    });

    expect(decoded.event.type).toBe('Release');
    if (decoded.event.type === 'Release') {
      expect(decoded.event.data.escrowId).toBe('1');
      expect(decoded.event.data.index).toBe(0);
      expect(decoded.event.data.amount).toBe('250');
    }
  });

  it('decodes a dispute event', () => {
    const symbol = xdr.ScVal.scvSymbol('dispute');
    const escrowId = xdr.ScVal.scvU64(xdr.Uint64.fromString('1'));
    const caller = xdr.ScVal.scvString('GCLIENTDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');

    const decoded = decodeEvent({
      id: 'test-id-4',
      ledger: 103,
      ledgerClosedAt: '2024-01-01T00:03:00Z',
      txHash: 'mnop',
      topic: [symbol, escrowId, caller],
      value: xdr.ScVal.scvVoid(),
    });

    expect(decoded.event.type).toBe('Dispute');
    if (decoded.event.type === 'Dispute') {
      expect(decoded.event.data.escrowId).toBe('1');
      expect(decoded.event.data.caller).toBe('GCLIENTDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    }
  });

  it('decodes a resolved event', () => {
    const symbol = xdr.ScVal.scvSymbol('resolved');
    const escrowId = xdr.ScVal.scvU64(xdr.Uint64.fromString('1'));
    const amount = nativeToScVal(250n, { type: 'u128' });

    const decoded = decodeEvent({
      id: 'test-id-5',
      ledger: 104,
      ledgerClosedAt: '2024-01-01T00:04:00Z',
      txHash: 'qrst',
      topic: [symbol, escrowId],
      value: amount,
    });

    expect(decoded.event.type).toBe('Resolved');
    if (decoded.event.type === 'Resolved') {
      expect(decoded.event.data.escrowId).toBe('1');
      expect(decoded.event.data.toFreelancer).toBe('250');
      expect(decoded.event.data.toClient).toBe('0');
    }
  });

  it('decodes a cancel event', () => {
    const symbol = xdr.ScVal.scvSymbol('cancel');
    const escrowId = xdr.ScVal.scvU64(xdr.Uint64.fromString('1'));
    const refund = nativeToScVal(500n, { type: 'u128' });

    const decoded = decodeEvent({
      id: 'test-id-6',
      ledger: 105,
      ledgerClosedAt: '2024-01-01T00:05:00Z',
      txHash: 'uvwx',
      topic: [symbol, escrowId],
      value: refund,
    });

    expect(decoded.event.type).toBe('Cancel');
    if (decoded.event.type === 'Cancel') {
      expect(decoded.event.data.escrowId).toBe('1');
      expect(decoded.event.data.refund).toBe('500');
    }
  });

  it('decodes a reputation event', () => {
    const symbol = xdr.ScVal.scvSymbol('rep');
    const escrowId = xdr.ScVal.scvU64(xdr.Uint64.fromString('1'));
    const freelancer = xdr.ScVal.scvString('GFREELANCERDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const rating = xdr.ScVal.scvU32(5);

    const decoded = decodeEvent({
      id: 'test-id-7',
      ledger: 106,
      ledgerClosedAt: '2024-01-01T00:06:00Z',
      txHash: 'yzab',
      topic: [symbol, escrowId, freelancer],
      value: rating,
    });

    expect(decoded.event.type).toBe('Reputation');
    if (decoded.event.type === 'Reputation') {
      expect(decoded.event.data.escrowId).toBe('1');
      expect(decoded.event.data.freelancer).toBe('GFREELANCERDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      expect(decoded.event.data.rating).toBe(5);
    }
  });

  it('decodes a paused event', () => {
    const symbol = xdr.ScVal.scvSymbol('paused');
    const paused = xdr.ScVal.scvBool(true);

    const decoded = decodeEvent({
      id: 'test-id-8',
      ledger: 107,
      ledgerClosedAt: '2024-01-01T00:07:00Z',
      txHash: 'cdef',
      topic: [symbol],
      value: paused,
    });

    expect(decoded.event.type).toBe('Paused');
    if (decoded.event.type === 'Paused') {
      expect(decoded.event.data.paused).toBe(true);
    }
  });

  it('decodes an init event', () => {
    const symbol = xdr.ScVal.scvSymbol('init');
    const admin = xdr.ScVal.scvString('GADMINDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');

    const decoded = decodeEvent({
      id: 'test-id-9',
      ledger: 108,
      ledgerClosedAt: '2024-01-01T00:08:00Z',
      txHash: 'ghij',
      topic: [symbol],
      value: admin,
    });

    expect(decoded.event.type).toBe('Init');
    if (decoded.event.type === 'Init') {
      expect(decoded.event.data.admin).toBe('GADMINDEMOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    }
  });

  it('handles unknown event types gracefully', () => {
    const symbol = xdr.ScVal.scvSymbol('unknown_type');
    const value = xdr.ScVal.scvU32(42);

    const decoded = decodeEvent({
      id: 'test-id-10',
      ledger: 109,
      ledgerClosedAt: '2024-01-01T00:09:00Z',
      txHash: 'klmn',
      topic: [symbol],
      value,
    });

    expect(decoded.event.type).toBe('Unknown');
    if (decoded.event.type === 'Unknown') {
      expect(decoded.event.data.topics).toEqual(['unknown_type']);
      expect(decoded.event.data.value).toBeDefined();
    }
  });

  it('handles malformed events gracefully', () => {
    const symbol = xdr.ScVal.scvSymbol('created');
    const value = xdr.ScVal.scvU32(42);

    const decoded = decodeEvent({
      id: 'test-id-11',
      ledger: 110,
      ledgerClosedAt: '2024-01-01T00:10:00Z',
      txHash: 'opqr',
      topic: [symbol],
      value,
    });

    expect(decoded.event.type).toBe('Unknown');
  });
});
