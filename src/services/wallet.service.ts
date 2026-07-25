/**
 * @module services/wallet.service
 * @description
 * Wallet validation and payment-limit enforcement.
 *
 * Responsibilities:
 *  1. Fetch the XLM balance of a Stellar account from Horizon.
 *  2. Enforce per-payment and per-day volume limits.
 *  3. Surface typed errors so PaymentsService can produce correct HTTP responses.
 *
 * ## Horizon integration
 * Uses the `STELLAR_HORIZON_URL` env var (validated at startup by env.schema.ts).
 * Calls `GET <horizon>/accounts/<address>` and parses the native XLM balance from
 * the response. No SDK dependency is added — a single fetch is all that's needed.
 *
 * ## Limit policy (conservative defaults, overridable via env)
 *  - MAX_PAYMENT_AMOUNT_STROOPS:  single payment cap (default 10 000 XLM)
 *  - MAX_DAILY_PAYMENT_STROOPS:   rolling 24-hour volume cap per sender (default 100 000 XLM)
 *
 * ## Security
 *  - Wallet addresses are never logged at INFO level — only at debug.
 *  - Balance values are logged as numeric stroops, not account IDs.
 *  - Horizon URL is SSRF-checked at startup via env.schema.ts.
 */

import { createLogger } from '../logger';

const log = createLogger({ service: 'wallet' });

// ─── Constants ────────────────────────────────────────────────────────────────

/** 1 XLM = 10 000 000 stroops */
export const STROOPS_PER_XLM = 10_000_000;

/**
 * Maximum amount allowed for a single payment (stroops).
 * Default: 10 000 XLM. Override with MAX_PAYMENT_AMOUNT_STROOPS env var.
 */
export const MAX_PAYMENT_AMOUNT_STROOPS: number = (() => {
  const raw = process.env['MAX_PAYMENT_AMOUNT_STROOPS'];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : 10_000 * STROOPS_PER_XLM;
})();

/**
 * Rolling 24-hour volume cap per sender (stroops).
 * Default: 100 000 XLM. Override with MAX_DAILY_PAYMENT_STROOPS env var.
 */
export const MAX_DAILY_PAYMENT_STROOPS: number = (() => {
  const raw = process.env['MAX_DAILY_PAYMENT_STROOPS'];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : 100_000 * STROOPS_PER_XLM;
})();

/** Minimum XLM reserve that must remain in the account after payment (2 XLM base reserve). */
const MIN_RESERVE_STROOPS = 2 * STROOPS_PER_XLM;

// ─── Typed errors ─────────────────────────────────────────────────────────────

/** Base class for all wallet-related errors. */
export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletError';
  }
}

/** Stellar account not found on-chain (never funded or doesn't exist). */
export class WalletNotFoundError extends WalletError {
  constructor() {
    super('Sender wallet account not found on the Stellar network');
    this.name = 'WalletNotFoundError';
  }
}

/** Account balance is insufficient to cover the payment + reserve. */
export class InsufficientBalanceError extends WalletError {
  constructor(available: number, required: number) {
    super(
      `Insufficient balance: available ${available} stroops, required ${required} stroops ` +
        `(including ${MIN_RESERVE_STROOPS} stroops minimum reserve)`,
    );
    this.name = 'InsufficientBalanceError';
  }
}

/** Payment amount exceeds the per-payment cap. */
export class PaymentLimitExceededError extends WalletError {
  constructor(amount: number, limit: number) {
    super(
      `Payment amount ${amount} stroops exceeds the single-payment limit of ${limit} stroops`,
    );
    this.name = 'PaymentLimitExceededError';
  }
}

/** Sender's rolling 24-hour volume would exceed the daily cap. */
export class DailyLimitExceededError extends WalletError {
  constructor(amount: number, alreadySpent: number, limit: number) {
    super(
      `Payment of ${amount} stroops would exceed the daily limit of ${limit} stroops ` +
        `(${alreadySpent} stroops already sent today)`,
    );
    this.name = 'DailyLimitExceededError';
  }
}

/** Horizon returned an unexpected response. */
export class WalletServiceUnavailableError extends WalletError {
  constructor(detail: string) {
    super(`Wallet service temporarily unavailable: ${detail}`);
    this.name = 'WalletServiceUnavailableError';
  }
}

// ─── Horizon types (minimal) ──────────────────────────────────────────────────

interface HorizonBalance {
  balance: string;
  asset_type: string;
}

interface HorizonAccountResponse {
  balances: HorizonBalance[];
}

// ─── WalletService ────────────────────────────────────────────────────────────

export interface WalletValidationResult {
  /** Native XLM balance of the sender in stroops. */
  balanceStroops: number;
}

export class WalletService {
  private readonly horizonUrl: string;

  constructor(horizonUrl?: string) {
    this.horizonUrl =
      horizonUrl ??
      process.env['STELLAR_HORIZON_URL'] ??
      'https://horizon-testnet.stellar.org';
  }

  /**
   * Fetches the native XLM balance for a Stellar account.
   *
   * @param stellarAddress - Public key (G… address) of the account.
   * @returns Balance in stroops.
   * @throws {WalletNotFoundError} Account does not exist on the network.
   * @throws {WalletServiceUnavailableError} Horizon is unreachable or returned unexpected data.
   */
  async getBalance(stellarAddress: string): Promise<number> {
    log.debug('Fetching wallet balance', { addressLength: stellarAddress.length });

    // Basic format check before hitting the network (G + 55 base32 chars = 56 total)
    if (!/^G[A-Z2-7]{55}$/.test(stellarAddress)) {
      throw new WalletNotFoundError();
    }

    const url = `${this.horizonUrl}/accounts/${encodeURIComponent(stellarAddress)}`;
    let res: Response;

    try {
      res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      log.warn('Horizon request failed', { detail });
      throw new WalletServiceUnavailableError(detail);
    }

    if (res.status === 404) {
      throw new WalletNotFoundError();
    }

    if (!res.ok) {
      throw new WalletServiceUnavailableError(`Horizon returned HTTP ${res.status}`);
    }

    let account: HorizonAccountResponse;
    try {
      account = (await res.json()) as HorizonAccountResponse;
    } catch {
      throw new WalletServiceUnavailableError('Failed to parse Horizon response as JSON');
    }

    const nativeBalance = account.balances?.find((b) => b.asset_type === 'native');
    if (!nativeBalance) {
      // Account exists but has no native balance entry — treat as 0
      return 0;
    }

    const balanceXlm = parseFloat(nativeBalance.balance);
    if (!Number.isFinite(balanceXlm)) {
      throw new WalletServiceUnavailableError(
        `Horizon returned non-numeric balance: ${nativeBalance.balance}`,
      );
    }

    return Math.floor(balanceXlm * STROOPS_PER_XLM);
  }

  /**
   * Validates that a payment can proceed by checking:
   *  1. The sender's wallet exists and has sufficient funds (including reserve).
   *  2. The payment amount is within the single-payment cap.
   *  3. The sender's rolling 24-hour volume won't exceed the daily cap.
   *
   * @param stellarAddress  - Sender's Stellar public key.
   * @param amountStroops   - Payment amount in stroops.
   * @param dailySpentStroops - Amount the sender has already sent in the last 24 h.
   * @returns {WalletValidationResult} on success.
   * @throws {WalletNotFoundError} when the account doesn't exist.
   * @throws {InsufficientBalanceError} when funds are too low.
   * @throws {PaymentLimitExceededError} when amount exceeds the per-payment cap.
   * @throws {DailyLimitExceededError} when the daily volume cap would be breached.
   */
  async validatePayment(
    stellarAddress: string,
    amountStroops: number,
    dailySpentStroops: number,
  ): Promise<WalletValidationResult> {
    // ── 1. Per-payment cap ──────────────────────────────────────────────────
    if (amountStroops > MAX_PAYMENT_AMOUNT_STROOPS) {
      throw new PaymentLimitExceededError(amountStroops, MAX_PAYMENT_AMOUNT_STROOPS);
    }

    // ── 2. Daily cap ────────────────────────────────────────────────────────
    const projectedDailyTotal = dailySpentStroops + amountStroops;
    if (projectedDailyTotal > MAX_DAILY_PAYMENT_STROOPS) {
      throw new DailyLimitExceededError(
        amountStroops,
        dailySpentStroops,
        MAX_DAILY_PAYMENT_STROOPS,
      );
    }

    // ── 3. Balance check ────────────────────────────────────────────────────
    const balanceStroops = await this.getBalance(stellarAddress);
    const required = amountStroops + MIN_RESERVE_STROOPS;

    if (balanceStroops < required) {
      log.warn('Insufficient balance for payment', {
        balanceStroops,
        required,
        amountStroops,
      });
      throw new InsufficientBalanceError(balanceStroops, required);
    }

    log.info('Wallet validation passed', { balanceStroops, amountStroops });
    return { balanceStroops };
  }
}
