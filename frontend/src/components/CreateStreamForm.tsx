import React, { useState, useEffect } from 'react';

/**
 * CreateStreamForm – Wave 4
 *
 * Fetches the allowed-assets list from GET /api/config on mount and renders a
 * <select> dropdown instead of the legacy free-text input.  Falls back to a
 * plain <input type="text"> if the fetch fails so the form remains usable.
 */

interface StreamFormData {
  recipient: string;
  amount: string;
  assetCode: string;
  duration: string;
}

interface ConfigResponse {
  allowedAssets: string[];
}

const API_BASE = process.env.REACT_APP_API_URL ?? 'http://localhost:3001';

export default function CreateStreamForm() {
  const [allowedAssets, setAllowedAssets] = useState<string[] | null>(null);
  const [configError, setConfigError] = useState(false);

  const [form, setForm] = useState<StreamFormData>({
    recipient: '',
    amount: '',
    assetCode: '',
    duration: '',
  });

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState(false);

  // ── Fetch allowed assets from backend config on mount ─────────────────────
  useEffect(() => {
    let cancelled = false;

    async function fetchConfig() {
      try {
        const res = await fetch(`${API_BASE}/api/config`);
        if (!res.ok) throw new Error(`Config fetch failed: ${res.status}`);
        const data: ConfigResponse = await res.json();
        if (cancelled) return;

        const assets = Array.isArray(data.allowedAssets) ? data.allowedAssets : [];
        setAllowedAssets(assets);

        // Default to USDC if present, otherwise the first available asset
        const defaultAsset = assets.includes('USDC') ? 'USDC' : assets[0] ?? '';
        setForm((prev) => ({ ...prev, assetCode: defaultAsset }));
      } catch {
        if (cancelled) return;
        setConfigError(true);
      }
    }

    void fetchConfig();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Handlers ──────────────────────────────────────────────────────────────
  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    setSubmitSuccess(false);

    try {
      const res = await fetch(`${API_BASE}/api/v1/streams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { message?: string }).message ?? `Error ${res.status}`);
      }

      setSubmitSuccess(true);
      setForm({ recipient: '', amount: '', assetCode: allowedAssets?.includes('USDC') ? 'USDC' : '', duration: '' });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'An unexpected error occurred.');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <form
      id="create-stream-form"
      onSubmit={handleSubmit}
      aria-label="Create payment stream"
    >
      <h2>Create Payment Stream</h2>

      {/* Recipient */}
      <div className="form-group">
        <label htmlFor="stream-recipient">Recipient Address</label>
        <input
          id="stream-recipient"
          name="recipient"
          type="text"
          value={form.recipient}
          onChange={handleChange}
          placeholder="G…"
          required
          autoComplete="off"
        />
      </div>

      {/* Amount */}
      <div className="form-group">
        <label htmlFor="stream-amount">Amount</label>
        <input
          id="stream-amount"
          name="amount"
          type="number"
          min="0.0000001"
          step="0.0000001"
          value={form.amount}
          onChange={handleChange}
          placeholder="0.00"
          required
        />
      </div>

      {/* Asset code – dropdown when config loaded, text fallback on error */}
      <div className="form-group">
        <label htmlFor="stream-asset-code">Asset Code</label>

        {configError ? (
          /* Fallback: plain text input when config fetch fails */
          <input
            id="stream-asset-code"
            name="assetCode"
            type="text"
            value={form.assetCode}
            onChange={handleChange}
            placeholder="e.g. USDC"
            required
            aria-describedby="asset-code-fallback-hint"
          />
        ) : allowedAssets === null ? (
          /* Loading state */
          <select id="stream-asset-code" name="assetCode" disabled aria-busy="true">
            <option>Loading assets…</option>
          </select>
        ) : (
          /* Happy path: dropdown populated from backend config */
          <select
            id="stream-asset-code"
            name="assetCode"
            value={form.assetCode}
            onChange={handleChange}
            required
          >
            {allowedAssets.length === 0 ? (
              <option value="" disabled>
                No assets available
              </option>
            ) : (
              allowedAssets.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))
            )}
          </select>
        )}

        {configError && (
          <small id="asset-code-fallback-hint" role="alert">
            Could not load asset list — enter the asset code manually.
          </small>
        )}
      </div>

      {/* Duration */}
      <div className="form-group">
        <label htmlFor="stream-duration">Duration (seconds)</label>
        <input
          id="stream-duration"
          name="duration"
          type="number"
          min="1"
          step="1"
          value={form.duration}
          onChange={handleChange}
          placeholder="e.g. 86400"
          required
        />
      </div>

      {/* Feedback */}
      {submitError && (
        <p className="form-error" role="alert">
          {submitError}
        </p>
      )}
      {submitSuccess && (
        <p className="form-success" role="status">
          Stream created successfully!
        </p>
      )}

      <button id="create-stream-submit" type="submit" disabled={submitting}>
        {submitting ? 'Creating…' : 'Create Stream'}
      </button>
    </form>
  );
}
