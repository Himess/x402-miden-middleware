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
});
