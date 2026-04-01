import { TransactionPoller, IBlockchainProvider } from './TransactionPoller';
import { TransactionStatus, transactionsDb } from '../models/Transaction';

describe('TransactionPoller', () => {
  let mockProvider: jest.Mocked<IBlockchainProvider>;
  let poller: TransactionPoller;

  beforeEach(() => {
    mockProvider = {
      getTransactionReceipt: jest.fn(),
    };
    transactionsDb.clear();
    // Using small delay for testing
    poller = new TransactionPoller(mockProvider, 3, 50);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // Helper to wait for all microtasks to clear
  const flushMicrotasks = () => new Promise(resolve => jest.requireActual('timers').setImmediate(resolve));

  it('should poll until success (case a: 3 blocks)', async () => {
    const txHash = '0x123';
    mockProvider.getTransactionReceipt
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: 1, transactionHash: txHash });

    const pollPromise = poller.poll(txHash);

    // Initial call (immediately)
    await flushMicrotasks();
    expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(transactionsDb.get(txHash)?.status).toBe(TransactionStatus.PENDING);
    expect(transactionsDb.get(txHash)?.retryCount).toBe(1);

    // Second call (after delay)
    jest.advanceTimersByTime(50);
    await flushMicrotasks();
    expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(2);

    // Third call
    jest.advanceTimersByTime(100);
    await flushMicrotasks();
    expect(transactionsDb.get(txHash)?.status).toBe(TransactionStatus.SUCCESS);
    expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(3);

    await pollPromise;
  });

  it('should handle immediate failure (case b)', async () => {
    const txHash = '0xabc';
    mockProvider.getTransactionReceipt.mockResolvedValueOnce({ status: 0, transactionHash: txHash });

    await poller.poll(txHash);

    expect(transactionsDb.get(txHash)?.status).toBe(TransactionStatus.FAILED);
    expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);
  });

  it('should timeout after max retries (case c)', async () => {
    const txHash = '0xtimeout';
    mockProvider.getTransactionReceipt.mockResolvedValue(null);

    const pollPromise = poller.poll(txHash);

    // Initial (1st check)
    await flushMicrotasks();
    // 2nd check
    jest.advanceTimersByTime(50);
    await flushMicrotasks();
    // 3rd check
    jest.advanceTimersByTime(100);
    await flushMicrotasks();
    // 4th call (triggers timeout check)
    jest.advanceTimersByTime(200);
    await flushMicrotasks();

    expect(transactionsDb.get(txHash)?.status).toBe(TransactionStatus.TIMEOUT);
    expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(3);
    await pollPromise;
  });

  it('should respect exponential backoff', async () => {
    const txHash = '0xbackoff';
    mockProvider.getTransactionReceipt.mockResolvedValue(null);
    const initialDelay = 100;
    poller = new TransactionPoller(mockProvider, 5, initialDelay);

    const pollPromise = poller.poll(txHash);
    await flushMicrotasks();
    expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);

    // 1st delay: 100
    jest.runOnlyPendingTimers();
    await flushMicrotasks();
    expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(2);

    // 2nd delay: 200
    jest.runOnlyPendingTimers();
    await flushMicrotasks();
    expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(3);

    // Stop polling
    const tx = transactionsDb.get(txHash);
    if (tx) tx.status = TransactionStatus.SUCCESS;
    
    jest.runAllTimers();
    await pollPromise;
  });


  it('should use default parameters in constructor', () => {
    const defaultPoller = new TransactionPoller(mockProvider);
    expect((defaultPoller as any).maxRetries).toBe(5);
    expect((defaultPoller as any).initialDelay).toBe(1000);
  });



  it('should stop polling if status is no longer PENDING', async () => {
    const txHash = '0xexternal';
    mockProvider.getTransactionReceipt.mockResolvedValue(null);
    
    const pollPromise = poller.poll(txHash);
    await flushMicrotasks();
    
    const tx = transactionsDb.get(txHash);
    if (tx) tx.status = TransactionStatus.SUCCESS;
    
    jest.advanceTimersByTime(50);
    await flushMicrotasks();
    
    expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);
    await pollPromise;
  });

  it('should handle provider errors and continue polling', async () => {
    const txHash = '0xerror';
    mockProvider.getTransactionReceipt
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({ status: 1, transactionHash: txHash });
      
    const pollPromise = poller.poll(txHash);
    
    await flushMicrotasks();
    expect(transactionsDb.get(txHash)?.status).toBe(TransactionStatus.PENDING);
    
    jest.advanceTimersByTime(50);
    await flushMicrotasks();
    
    expect(transactionsDb.get(txHash)?.status).toBe(TransactionStatus.SUCCESS);
    await pollPromise;
  });

  it('should handle polling for missing transaction gracefully', async () => {
    const txHash = '0xmissing';
    mockProvider.getTransactionReceipt.mockResolvedValue(null);
    
    const pollPromise = poller.poll(txHash);
    await flushMicrotasks();
    
    transactionsDb.delete(txHash);
    
    jest.advanceTimersByTime(50);
    await flushMicrotasks();
    
    expect(mockProvider.getTransactionReceipt).toHaveBeenCalledTimes(1);
    await pollPromise;
  });

  it('should catch unexpected errors and log them', async () => {
    const txHash = '0xfatal';
    const tx = { hash: txHash, status: TransactionStatus.PENDING, retryCount: 0 };
    transactionsDb.set(txHash, tx);

    // Mocking pollWithBackoff to throw synchronously to trigger catch in poll
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('Fatal');
    
    // We need to trigger an error that the .poll catches.
    // If we mock the instance method, it should work.
    const originalMethod = (poller as any).pollWithBackoff;
    (poller as any).pollWithBackoff = jest.fn().mockRejectedValue(error);

    await poller.poll(txHash);
    expect(spy).toHaveBeenCalledWith(`Polling orchestrator failed for ${txHash}:`, error);
    
    spy.mockRestore();
    (poller as any).pollWithBackoff = originalMethod;
  });


});
