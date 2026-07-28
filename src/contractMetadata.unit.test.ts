import { computeMetadataHash, fetchAndVerify, resetMetricsForTest } from './contractMetadata';
import { register } from 'prom-client';
import { ContractMetadataMismatchError } from './errors/appError';

describe('contractMetadata module', () => {
  beforeEach(() => {
    resetMetricsForTest();
  });

  it('computeMetadataHash is deterministic regardless of key order', () => {
    const a = { b: 2, a: 1 };
    const b = { a: 1, b: 2 };

    const ha = computeMetadataHash(a);
    const hb = computeMetadataHash(b);

    expect(ha).toEqual(hb);
    expect(ha).toMatch(/^[0-9a-f]{64}$/i);
  });

  it('fetchAndVerify returns metadata when expected hash matches', async () => {
    const metadata = { version: 1, name: 'escrow' };
    const hash = computeMetadataHash(metadata);

    const fetcher = jest.fn().mockResolvedValue({ result: metadata });

    const out = await fetchAndVerify('CABC', 'https://rpc.test', hash, fetcher);
    expect(out).toEqual(metadata);
    expect(fetcher).toHaveBeenCalled();
  });

  it('fetchAndVerify throws ContractMetadataMismatchError and increments metric on mismatch', async () => {
    const metadata = { version: 1, name: 'escrow' };
    const wrongHash = '0'.repeat(64);

    const fetcher = jest.fn().mockResolvedValue({ result: metadata });

    await expect(fetchAndVerify('CABC', 'https://rpc.test', wrongHash, fetcher)).rejects.toBeInstanceOf(
      ContractMetadataMismatchError,
    );

    // Inspect metrics to ensure counter was incremented
    const metrics = await register.getMetricsAsJSON();
    const metric = metrics.find((m: any) => m.name === 'contract_metadata_mismatch_total');
    expect(metric).toBeDefined();
    const val = metric!.values?.find((v: any) => v.labels && v.labels.contract === 'CABC');
    expect(val).toBeDefined();
    expect(val!.value).toBe(1);
  });
});
