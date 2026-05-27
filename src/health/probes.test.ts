import { dbProbe, envProbe, redisProbe, stellarRpcProbe } from "./probes";

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

// ── dbProbe ────────────────────────────────────────────────────────────────

jest.mock("../db/database");

import { getDb } from "../db/database";

const mockGetDb = getDb as jest.MockedFunction<typeof getDb>;

describe("dbProbe", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("returns ok when SELECT 1 succeeds", async () => {
    mockGetDb.mockReturnValue({
      prepare: () => ({ run: () => undefined }),
    } as unknown as ReturnType<typeof getDb>);

    const result = await dbProbe();
    expect(result.ok).toBe(true);
    expect(result.name).toBe("db");
    expect(typeof result.latencyMs).toBe("number");
  });

  it("returns not ok when getDb throws", async () => {
    mockGetDb.mockImplementation(() => {
      throw new Error("SQLITE_CANTOPEN");
    });

    const result = await dbProbe();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("SQLITE_CANTOPEN");
  });

  it("returns not ok when prepare().run() throws", async () => {
    mockGetDb.mockReturnValue({
      prepare: () => ({
        run: () => {
          throw new Error("disk I/O error");
        },
      }),
    } as unknown as ReturnType<typeof getDb>);

    const result = await dbProbe();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("disk I/O error");
  });

  it("handles non-Error thrown values", async () => {
    mockGetDb.mockImplementation(() => {
      throw "raw string error";
    });

    const result = await dbProbe();
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("unknown error");
  });

  it("returns a numeric latencyMs", async () => {
    mockGetDb.mockReturnValue({
      prepare: () => ({ run: () => undefined }),
    } as unknown as ReturnType<typeof getDb>);

    const result = await dbProbe();
    expect(typeof result.latencyMs).toBe("number");
  });
});

// ── redisProbe ─────────────────────────────────────────────────────────────

jest.mock("ioredis", () => {
  return jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue("PONG"),
    disconnect: jest.fn().mockReturnValue(undefined),
    on: jest.fn().mockReturnThis(),
  }));
});

import Redis from "ioredis";

const MockRedis = Redis as unknown as jest.Mock;

describe("redisProbe", () => {
  const ORIGINAL = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL };
    jest.resetAllMocks();
  });

  afterEach(() => {
    process.env = ORIGINAL;
  });

  function buildMockClient(
    opts: { connectError?: Error; pingError?: Error } = {},
  ) {
    const mockConnect = opts.connectError
      ? jest.fn().mockRejectedValue(opts.connectError)
      : jest.fn().mockResolvedValue(undefined);
    const mockPing = opts.pingError
      ? jest.fn().mockRejectedValue(opts.pingError)
      : jest.fn().mockResolvedValue("PONG");
    const mockDisconnect = jest.fn().mockReturnValue(undefined);
    const mockOn = jest.fn().mockReturnThis();

    return { connect: mockConnect, ping: mockPing, disconnect: mockDisconnect, on: mockOn };
  }

  it("returns ok when Redis PING succeeds", async () => {
    const mockClient = buildMockClient();
    MockRedis.mockImplementation(() => mockClient as unknown as Redis);

    const result = await redisProbe();
    expect(result.ok).toBe(true);
    expect(result.name).toBe("redis");
    expect(mockClient.ping).toHaveBeenCalled();
    expect(mockClient.disconnect).toHaveBeenCalled();
  });

  it("returns not ok when connect throws", async () => {
    const mockClient = buildMockClient({ connectError: new Error("ECONNREFUSED") });
    MockRedis.mockImplementation(() => mockClient as unknown as Redis);

    const result = await redisProbe();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("ECONNREFUSED");
  });

  it("returns not ok when PING throws", async () => {
    const mockClient = buildMockClient({ pingError: new Error("NOAUTH Authentication required") });
    MockRedis.mockImplementation(() => mockClient as unknown as Redis);

    const result = await redisProbe();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("NOAUTH");
  });

  it("handles non-Error thrown values", async () => {
    const mockClient = buildMockClient({ connectError: new Error("unknown") });
    // Override to throw a raw string
    mockClient.connect = jest.fn().mockRejectedValue("raw");
    MockRedis.mockImplementation(() => mockClient as unknown as Redis);

    const result = await redisProbe();
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("unknown error");
  });

  it("uses REDIS_HOST, REDIS_PORT, REDIS_PASSWORD from env", async () => {
    process.env.REDIS_HOST = "redis.example.com";
    process.env.REDIS_PORT = "6380";
    process.env.REDIS_PASSWORD = "secret";
    const mockClient = buildMockClient();
    MockRedis.mockImplementation(() => mockClient as unknown as Redis);

    await redisProbe();

    const calls = MockRedis.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const ctorArg = calls[0][0];
    expect(ctorArg["host"]).toBe("redis.example.com");
    expect(ctorArg["port"]).toBe(6380);
    expect(ctorArg["password"]).toBe("secret");
  });

  it("returns a numeric latencyMs", async () => {
    const mockClient = buildMockClient();
    MockRedis.mockImplementation(() => mockClient as unknown as Redis);

    const result = await redisProbe();
    expect(typeof result.latencyMs).toBe("number");
  });

  it("still calls disconnect when ping throws", async () => {
    const mockClient = buildMockClient({ pingError: new Error("err") });
    MockRedis.mockImplementation(() => mockClient as unknown as Redis);

    await redisProbe();
    expect(mockClient.disconnect).toHaveBeenCalled();
  });
});
