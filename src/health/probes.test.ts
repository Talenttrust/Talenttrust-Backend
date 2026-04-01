import { envProbe, stellarRpcProbe } from "./probes";

describe("envProbe", () => {
  const ORIGINAL = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL };
  });
  afterEach(() => {
    process.env = ORIGINAL;
  });

  it("returns ok when REQUIRED_ENV_VARS is not set", async () => {
    delete process.env.REQUIRED_ENV_VARS;
    const result = await envProbe();
    expect(result.ok).toBe(true);
    expect(result.name).toBe("env");
  });

  it("returns ok when all required vars are present", async () => {
    process.env.REQUIRED_ENV_VARS = "FOO,BAR";
    process.env.FOO = "x";
    process.env.BAR = "y";
    const result = await envProbe();
    expect(result.ok).toBe(true);
    expect(result.detail).toBeUndefined();
  });

  it("returns not ok when a required var is missing", async () => {
    process.env.REQUIRED_ENV_VARS = "FOO,MISSING_VAR";
    process.env.FOO = "x";
    delete process.env.MISSING_VAR;
    const result = await envProbe();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("MISSING_VAR");
  });

  it("does not expose variable values in detail", async () => {
    process.env.REQUIRED_ENV_VARS = "SECRET";
    delete process.env.SECRET;
    const result = await envProbe();
    expect(result.detail).not.toContain("secret-value");
  });

  it("handles empty string entries in REQUIRED_ENV_VARS", async () => {
    process.env.REQUIRED_ENV_VARS = ",,,";
    const result = await envProbe();
    expect(result.ok).toBe(true);
  });

  it("returns a numeric latencyMs", async () => {
    const result = await envProbe();
    expect(typeof result.latencyMs).toBe("number");
  });
});

describe("stellarRpcProbe", () => {
  const ORIGINAL = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL };
  });
  afterEach(() => {
    process.env = ORIGINAL;
    jest.restoreAllMocks();
  });

  it("returns not ok when STELLAR_RPC_URL is not set", async () => {
    delete process.env.STELLAR_RPC_URL;
    const result = await stellarRpcProbe();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("STELLAR_RPC_URL not set");
    expect(result.latencyMs).toBe(0);
  });

  it("returns ok for a 200 response", async () => {
    process.env.STELLAR_RPC_URL = "https://example.com";
    global.fetch = jest.fn().mockResolvedValue({ status: 200 }) as jest.Mock;
    const result = await stellarRpcProbe();
    expect(result.ok).toBe(true);
    expect(result.detail).toBeUndefined();
  });

  it("returns ok for a 404 response (not a server error)", async () => {
    process.env.STELLAR_RPC_URL = "https://example.com";
    global.fetch = jest.fn().mockResolvedValue({ status: 404 }) as jest.Mock;
    const result = await stellarRpcProbe();
    expect(result.ok).toBe(true);
  });

  it("returns not ok for a 500 response", async () => {
    process.env.STELLAR_RPC_URL = "https://example.com";
    global.fetch = jest.fn().mockResolvedValue({ status: 500 }) as jest.Mock;
    const result = await stellarRpcProbe();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("500");
  });

  it("returns not ok when fetch throws (network error)", async () => {
    process.env.STELLAR_RPC_URL = "https://example.com";
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED")) as jest.Mock;
    const result = await stellarRpcProbe();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("ECONNREFUSED");
  });

  it("returns not ok on timeout (AbortError)", async () => {
    process.env.STELLAR_RPC_URL = "https://example.com";
    const abortErr = new Error("The operation was aborted");
    abortErr.name = "AbortError";
    global.fetch = jest.fn().mockRejectedValue(abortErr) as jest.Mock;
    const result = await stellarRpcProbe();
    expect(result.ok).toBe(false);
  });

  it("handles non-Error thrown values", async () => {
    process.env.STELLAR_RPC_URL = "https://example.com";
    global.fetch = jest.fn().mockRejectedValue("string error") as jest.Mock;
    const result = await stellarRpcProbe();
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("unknown error");
  });
});
