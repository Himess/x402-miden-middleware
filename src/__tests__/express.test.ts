import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import { midenPaywall } from "../express.js";
import type { MidenPaywallConfig } from "../types.js";

// ============================================================================
// Test helpers
// ============================================================================

const DEFAULT_CONFIG: MidenPaywallConfig = {
  price: "1000",
  asset: "0xabc123faucet",
  recipient: "0xdef456recipient",
  network: "miden:testnet",
  verifyPayment: async () => ({ valid: true, transactionId: "tx_verified" }),
};

function makePaymentHeader(overrides: Record<string, unknown> = {}): string {
  const payload = {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "miden:testnet",
      amount: "1000",
      payTo: "0xdef456recipient",
      maxTimeoutSeconds: 300,
      asset: "0xabc123faucet",
    },
    payload: {
      from: "0xsender123",
      provenTransaction: "deadbeef",
      transactionId: "tx_001",
    },
    ...overrides,
  };
  return btoa(JSON.stringify(payload));
}

/** Simulate an Express request/response cycle without starting a server. */
async function simulateRequest(
  app: express.Express,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const req = {
      method,
      url: path,
      originalUrl: path,
      protocol: "http",
      headers: { ...headers },
      get: (name: string) => {
        if (name.toLowerCase() === "host") return "localhost:3000";
        return headers[name.toLowerCase()];
      },
    } as unknown as express.Request;

    let statusCode = 200;
    let responseBody: Record<string, unknown> = {};

    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (body: Record<string, unknown>) => {
        responseBody = body;
        resolve({ status: statusCode, body: responseBody });
      },
    } as unknown as express.Response;

    const next = () => {
      // If next() is called, it means the middleware passed through
      resolve({ status: 200, body: { passed: true } });
    };

    // Get the middleware stack and execute
    const middleware = app._router?.stack?.find(
      (layer: { route?: { path: string } }) =>
        layer.route?.path === path || !layer.route,
    );

    // Simpler: just call the middleware directly
    const paywallMiddleware = midenPaywall(DEFAULT_CONFIG);
    paywallMiddleware(req, res, next);
  });
}

// ============================================================================
// Express middleware tests
// ============================================================================

describe("Express midenPaywall", () => {
  it("returns 402 when no Payment header is present", async () => {
    const middleware = midenPaywall(DEFAULT_CONFIG);

    const req = {
      method: "GET",
      originalUrl: "/api/premium/data",
      protocol: "http",
      headers: {},
      get: (name: string) =>
        name.toLowerCase() === "host" ? "localhost:3000" : undefined,
    } as unknown as express.Request;

    let statusCode = 0;
    let responseBody: Record<string, unknown> = {};

    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (body: Record<string, unknown>) => {
        responseBody = body;
      },
    } as unknown as express.Response;

    const next = vi.fn();

    await middleware(req, res, next);

    expect(statusCode).toBe(402);
    expect(responseBody).toHaveProperty("x402Version", 2);
    expect(responseBody).toHaveProperty("accepts");
    expect(next).not.toHaveBeenCalled();
  });

  it("passes through when valid Payment header is present", async () => {
    const middleware = midenPaywall(DEFAULT_CONFIG);

    const paymentHeader = makePaymentHeader();

    const req = {
      method: "GET",
      originalUrl: "/api/premium/data",
      protocol: "http",
      headers: { payment: paymentHeader },
      get: (name: string) =>
        name.toLowerCase() === "host" ? "localhost:3000" : undefined,
    } as unknown as express.Request;

    let statusCode = 0;
    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: vi.fn(),
    } as unknown as express.Response;

    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(statusCode).toBe(0); // status() should not have been called
    expect((req as express.Request & { paymentInfo?: unknown }).paymentInfo).toEqual({
      transactionId: "tx_001",
      from: "0xsender123",
      amount: "1000",
      asset: "0xabc123faucet",
    });
  });

  it("returns 400 for invalid Payment header encoding", async () => {
    const middleware = midenPaywall(DEFAULT_CONFIG);

    const req = {
      method: "GET",
      originalUrl: "/api/premium/data",
      protocol: "http",
      headers: { payment: "totally-broken-header" },
      get: (name: string) =>
        name.toLowerCase() === "host" ? "localhost:3000" : undefined,
    } as unknown as express.Request;

    let statusCode = 0;
    let responseBody: Record<string, unknown> = {};

    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (body: Record<string, unknown>) => {
        responseBody = body;
      },
    } as unknown as express.Response;

    const next = vi.fn();

    await middleware(req, res, next);

    expect(statusCode).toBe(400);
    expect(responseBody).toHaveProperty("error");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 402 when verification fails", async () => {
    const config: MidenPaywallConfig = {
      ...DEFAULT_CONFIG,
      verifyPayment: async () => ({
        valid: false,
        error: "Proof verification failed",
      }),
    };

    const middleware = midenPaywall(config);
    const paymentHeader = makePaymentHeader();

    const req = {
      method: "GET",
      originalUrl: "/api/premium/data",
      protocol: "http",
      headers: { payment: paymentHeader },
      get: (name: string) =>
        name.toLowerCase() === "host" ? "localhost:3000" : undefined,
    } as unknown as express.Request;

    let statusCode = 0;
    let responseBody: Record<string, unknown> = {};

    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (body: Record<string, unknown>) => {
        responseBody = body;
      },
    } as unknown as express.Response;

    const next = vi.fn();

    await middleware(req, res, next);

    expect(statusCode).toBe(402);
    expect(responseBody).toHaveProperty("error", "Proof verification failed");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 402 when payment amount is insufficient", async () => {
    const config: MidenPaywallConfig = {
      ...DEFAULT_CONFIG,
      verifyPayment: async () => ({ valid: true, transactionId: "tx_ok" }),
    };

    const middleware = midenPaywall(config);
    // Payment with amount 500, but config requires 1000
    const paymentHeader = makePaymentHeader({
      accepted: {
        scheme: "exact",
        network: "miden:testnet",
        amount: "500",
        payTo: "0xdef456recipient",
        maxTimeoutSeconds: 300,
        asset: "0xabc123faucet",
      },
    });

    const req = {
      method: "GET",
      originalUrl: "/api/premium/data",
      protocol: "http",
      headers: { payment: paymentHeader },
      get: (name: string) =>
        name.toLowerCase() === "host" ? "localhost:3000" : undefined,
    } as unknown as express.Request;

    let statusCode = 0;
    let responseBody: Record<string, unknown> = {};

    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (body: Record<string, unknown>) => {
        responseBody = body;
      },
    } as unknown as express.Response;

    const next = vi.fn();

    await middleware(req, res, next);

    expect(statusCode).toBe(402);
    expect(String(responseBody.error)).toContain("Insufficient");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 402 when wrong network", async () => {
    const middleware = midenPaywall(DEFAULT_CONFIG);
    const paymentHeader = makePaymentHeader({
      accepted: {
        scheme: "exact",
        network: "miden:mainnet", // config expects testnet
        amount: "1000",
        payTo: "0xdef456recipient",
        maxTimeoutSeconds: 300,
        asset: "0xabc123faucet",
      },
    });

    const req = {
      method: "GET",
      originalUrl: "/api/premium/data",
      protocol: "http",
      headers: { payment: paymentHeader },
      get: (name: string) =>
        name.toLowerCase() === "host" ? "localhost:3000" : undefined,
    } as unknown as express.Request;

    let statusCode = 0;
    let responseBody: Record<string, unknown> = {};

    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (body: Record<string, unknown>) => {
        responseBody = body;
      },
    } as unknown as express.Response;

    const next = vi.fn();

    await middleware(req, res, next);

    expect(statusCode).toBe(402);
    expect(String(responseBody.error)).toContain("network");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 402 when wrong asset", async () => {
    const middleware = midenPaywall(DEFAULT_CONFIG);
    const paymentHeader = makePaymentHeader({
      accepted: {
        scheme: "exact",
        network: "miden:testnet",
        amount: "1000",
        payTo: "0xdef456recipient",
        maxTimeoutSeconds: 300,
        asset: "0xwrongfaucet",
      },
    });

    const req = {
      method: "GET",
      originalUrl: "/api/premium/data",
      protocol: "http",
      headers: { payment: paymentHeader },
      get: (name: string) =>
        name.toLowerCase() === "host" ? "localhost:3000" : undefined,
    } as unknown as express.Request;

    let statusCode = 0;
    let responseBody: Record<string, unknown> = {};

    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (body: Record<string, unknown>) => {
        responseBody = body;
      },
    } as unknown as express.Response;

    const next = vi.fn();

    await middleware(req, res, next);

    expect(statusCode).toBe(402);
    expect(String(responseBody.error)).toContain("asset");
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 500 when verify function throws", async () => {
    const config: MidenPaywallConfig = {
      ...DEFAULT_CONFIG,
      verifyPayment: async () => {
        throw new Error("Unexpected verify crash");
      },
    };

    const middleware = midenPaywall(config);
    const paymentHeader = makePaymentHeader();

    const req = {
      method: "GET",
      originalUrl: "/api/premium/data",
      protocol: "http",
      headers: { payment: paymentHeader },
      get: (name: string) =>
        name.toLowerCase() === "host" ? "localhost:3000" : undefined,
    } as unknown as express.Request;

    let statusCode = 0;
    let responseBody: Record<string, unknown> = {};

    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (body: Record<string, unknown>) => {
        responseBody = body;
      },
    } as unknown as express.Response;

    const next = vi.fn();

    await middleware(req, res, next);

    expect(statusCode).toBe(500);
    expect(String(responseBody.error)).toContain("Unexpected verify crash");
    expect(next).not.toHaveBeenCalled();
  });

  it("accepts overpayment", async () => {
    const middleware = midenPaywall(DEFAULT_CONFIG);
    const paymentHeader = makePaymentHeader({
      accepted: {
        scheme: "exact",
        network: "miden:testnet",
        amount: "5000", // > required 1000
        payTo: "0xdef456recipient",
        maxTimeoutSeconds: 300,
        asset: "0xabc123faucet",
      },
    });

    const req = {
      method: "GET",
      originalUrl: "/api/premium/data",
      protocol: "http",
      headers: { payment: paymentHeader },
      get: (name: string) =>
        name.toLowerCase() === "host" ? "localhost:3000" : undefined,
    } as unknown as express.Request;

    let statusCode = 0;
    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: vi.fn(),
    } as unknown as express.Response;

    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(statusCode).toBe(0);
  });

  it("does not set x-privacy-mode header for public mode", async () => {
    const middleware = midenPaywall(DEFAULT_CONFIG);

    const req = {
      method: "GET",
      originalUrl: "/api/premium/data",
      protocol: "http",
      headers: {},
      get: (name: string) =>
        name.toLowerCase() === "host" ? "localhost:3000" : undefined,
    } as unknown as express.Request;

    const headers: Record<string, string> = {};
    const res = {
      status: () => res,
      setHeader: (name: string, value: string) => { headers[name] = value; },
      json: () => {},
    } as unknown as express.Response;

    await middleware(req, res, vi.fn());

    expect(headers).not.toHaveProperty("x-privacy-mode");
  });

  it("sets x-privacy-mode header for trusted mode", async () => {
    const config: MidenPaywallConfig = {
      ...DEFAULT_CONFIG,
      privacy: "trusted",
    };
    const middleware = midenPaywall(config);

    const req = {
      method: "GET",
      originalUrl: "/api/premium/data",
      protocol: "http",
      headers: {},
      get: (name: string) =>
        name.toLowerCase() === "host" ? "localhost:3000" : undefined,
    } as unknown as express.Request;

    const headers: Record<string, string> = {};
    const res = {
      status: () => res,
      setHeader: (name: string, value: string) => { headers[name] = value; },
      json: () => {},
    } as unknown as express.Response;

    await middleware(req, res, vi.fn());

    expect(headers["x-privacy-mode"]).toBe("trusted");
  });

  it("rejects trusted mode payment without noteData", async () => {
    const config: MidenPaywallConfig = {
      ...DEFAULT_CONFIG,
      privacy: "trusted",
    };
    const middleware = midenPaywall(config);
    const paymentHeader = makePaymentHeader(); // no noteData

    const req = {
      method: "GET",
      originalUrl: "/api/premium/data",
      protocol: "http",
      headers: { payment: paymentHeader },
      get: (name: string) =>
        name.toLowerCase() === "host" ? "localhost:3000" : undefined,
    } as unknown as express.Request;

    let statusCode = 0;
    let responseBody: Record<string, unknown> = {};

    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (body: Record<string, unknown>) => {
        responseBody = body;
      },
    } as unknown as express.Response;

    const next = vi.fn();
    await middleware(req, res, next);

    expect(statusCode).toBe(402);
    expect(String(responseBody.error)).toContain("noteData");
    expect(next).not.toHaveBeenCalled();
  });

  it("throws NotImplemented for encrypted privacy mode", () => {
    expect(() =>
      midenPaywall({ ...DEFAULT_CONFIG, privacy: "encrypted" }),
    ).toThrow("not yet implemented");
  });

  it("throws NotImplemented for zkproof privacy mode", () => {
    expect(() =>
      midenPaywall({ ...DEFAULT_CONFIG, privacy: "zkproof" }),
    ).toThrow("not yet implemented");
  });

  it("402 response includes proper accepts array", async () => {
    const middleware = midenPaywall(DEFAULT_CONFIG);

    const req = {
      method: "GET",
      originalUrl: "/api/premium/data",
      protocol: "http",
      headers: {},
      get: (name: string) =>
        name.toLowerCase() === "host" ? "localhost:3000" : undefined,
    } as unknown as express.Request;

    let responseBody: Record<string, unknown> = {};

    const res = {
      status: () => res,
      json: (body: Record<string, unknown>) => {
        responseBody = body;
      },
    } as unknown as express.Response;

    await middleware(req, res, vi.fn());

    const accepts = responseBody.accepts as Array<Record<string, unknown>>;
    expect(accepts).toHaveLength(1);
    expect(accepts[0]).toEqual({
      scheme: "exact",
      network: "miden:testnet",
      amount: "1000",
      payTo: "0xdef456recipient",
      maxTimeoutSeconds: 300,
      asset: "0xabc123faucet",
    });
  });

  it("handles 10 concurrent requests with different valid payment headers", async () => {
    const middleware = midenPaywall(DEFAULT_CONFIG);

    const requests = Array.from({ length: 10 }, (_, i) => {
      const paymentHeader = makePaymentHeader({
        payload: {
          from: `0xsender_${i}`,
          provenTransaction: "deadbeef",
          transactionId: `tx_concurrent_${i}`,
        },
      });

      return new Promise<{ status: number; passed: boolean }>((resolve) => {
        const req = {
          method: "GET",
          originalUrl: "/api/premium/data",
          protocol: "http",
          headers: { payment: paymentHeader },
          get: (name: string) =>
            name.toLowerCase() === "host" ? "localhost:3000" : undefined,
        } as unknown as express.Request;

        let statusCode = 0;
        const res = {
          status: (code: number) => {
            statusCode = code;
            return res;
          },
          json: () => {
            resolve({ status: statusCode, passed: false });
          },
        } as unknown as express.Response;

        const next = () => {
          resolve({ status: 200, passed: true });
        };

        middleware(req, res, next);
      });
    });

    const results = await Promise.all(requests);
    // All should pass (status 200) since all have unique transactionIds
    for (const r of results) {
      expect(r.passed).toBe(true);
      expect(r.status).toBe(200);
    }
  });

  it("handles 10 concurrent requests with same payment header (replay protection)", async () => {
    const middleware = midenPaywall(DEFAULT_CONFIG);
    const paymentHeader = makePaymentHeader({
      payload: {
        from: "0xsender_same",
        provenTransaction: "deadbeef",
        transactionId: "tx_replay_concurrent",
      },
    });

    const requests = Array.from({ length: 10 }, () => {
      return new Promise<{ status: number; passed: boolean; error?: string }>((resolve) => {
        const req = {
          method: "GET",
          originalUrl: "/api/premium/data",
          protocol: "http",
          headers: { payment: paymentHeader },
          get: (name: string) =>
            name.toLowerCase() === "host" ? "localhost:3000" : undefined,
        } as unknown as express.Request;

        let statusCode = 0;
        let responseBody: Record<string, unknown> = {};
        const res = {
          status: (code: number) => {
            statusCode = code;
            return res;
          },
          json: (body: Record<string, unknown>) => {
            responseBody = body;
            resolve({ status: statusCode, passed: false, error: String(responseBody.error ?? "") });
          },
        } as unknown as express.Response;

        const next = () => {
          resolve({ status: 200, passed: true });
        };

        middleware(req, res, next);
      });
    });

    const results = await Promise.all(requests);
    const passed = results.filter((r) => r.passed);
    const rejected = results.filter((r) => !r.passed);

    // Only the first should pass; rest should be replays
    expect(passed.length).toBe(1);
    expect(rejected.length).toBe(9);
    for (const r of rejected) {
      expect(r.status).toBe(402);
      expect(r.error).toContain("replay");
    }
  });

  it("rejects replay of same transactionId on second request", async () => {
    const middleware = midenPaywall(DEFAULT_CONFIG);
    const paymentHeader = makePaymentHeader();

    // Helper to create a mock request/response pair
    function makeMocks() {
      const req = {
        method: "GET",
        originalUrl: "/api/premium/data",
        protocol: "http",
        headers: { payment: paymentHeader },
        get: (name: string) =>
          name.toLowerCase() === "host" ? "localhost:3000" : undefined,
      } as unknown as express.Request;

      let statusCode = 0;
      let responseBody: Record<string, unknown> = {};
      const res = {
        status: (code: number) => {
          statusCode = code;
          return res;
        },
        json: (body: Record<string, unknown>) => {
          responseBody = body;
        },
      } as unknown as express.Response;

      const next = vi.fn();

      return {
        req,
        res,
        next,
        getStatus: () => statusCode,
        getBody: () => responseBody,
      };
    }

    // First request: should pass through
    const first = makeMocks();
    await middleware(first.req, first.res, first.next);
    expect(first.next).toHaveBeenCalledOnce();

    // Second request with same transactionId: should be rejected as replay
    const second = makeMocks();
    await middleware(second.req, second.res, second.next);
    expect(second.getStatus()).toBe(402);
    expect(String(second.getBody().error)).toContain("replay");
    expect(second.next).not.toHaveBeenCalled();
  });
});
