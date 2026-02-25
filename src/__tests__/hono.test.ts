import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { midenPaywall } from "../hono.js";
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

function createApp(config: MidenPaywallConfig = DEFAULT_CONFIG): Hono {
  const app = new Hono();

  app.use("/api/premium/*", midenPaywall(config));

  app.get("/api/premium/data", (c) => {
    const paymentInfo = c.get("paymentInfo");
    return c.json({ data: "premium content", payment: paymentInfo });
  });

  app.get("/api/free/data", (c) => {
    return c.json({ data: "free content" });
  });

  return app;
}

// ============================================================================
// Hono middleware tests
// ============================================================================

describe("Hono midenPaywall", () => {
  it("returns 402 when no Payment header is present", async () => {
    const app = createApp();
    const res = await app.request("/api/premium/data");

    expect(res.status).toBe(402);

    const body = await res.json();
    expect(body.x402Version).toBe(2);
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0].scheme).toBe("exact");
    expect(body.accepts[0].amount).toBe("1000");
    expect(body.accepts[0].asset).toBe("0xabc123faucet");
    expect(body.accepts[0].payTo).toBe("0xdef456recipient");
  });

  it("passes through when valid Payment header is present", async () => {
    const app = createApp();
    const paymentHeader = makePaymentHeader();

    const res = await app.request("/api/premium/data", {
      headers: { Payment: paymentHeader },
    });

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toBe("premium content");
    expect(body.payment).toEqual({
      transactionId: "tx_001",
      from: "0xsender123",
      amount: "1000",
      asset: "0xabc123faucet",
    });
  });

  it("does not affect non-paywalled routes", async () => {
    const app = createApp();
    const res = await app.request("/api/free/data");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBe("free content");
  });

  it("returns 400 for invalid Payment header encoding", async () => {
    const app = createApp();
    const res = await app.request("/api/premium/data", {
      headers: { Payment: "totally-broken-header" },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid");
  });

  it("returns 402 when verification fails", async () => {
    const config: MidenPaywallConfig = {
      ...DEFAULT_CONFIG,
      verifyPayment: async () => ({
        valid: false,
        error: "STARK proof invalid",
      }),
    };

    const app = createApp(config);
    const paymentHeader = makePaymentHeader();

    const res = await app.request("/api/premium/data", {
      headers: { Payment: paymentHeader },
    });

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("STARK proof invalid");
  });

  it("returns 402 when amount is insufficient", async () => {
    const app = createApp();

    const paymentHeader = makePaymentHeader({
      accepted: {
        scheme: "exact",
        network: "miden:testnet",
        amount: "500", // < required 1000
        payTo: "0xdef456recipient",
        maxTimeoutSeconds: 300,
        asset: "0xabc123faucet",
      },
    });

    const res = await app.request("/api/premium/data", {
      headers: { Payment: paymentHeader },
    });

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toContain("Insufficient");
  });

  it("returns 402 when wrong network", async () => {
    const app = createApp();

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

    const res = await app.request("/api/premium/data", {
      headers: { Payment: paymentHeader },
    });

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toContain("network");
  });

  it("returns 402 when wrong asset", async () => {
    const app = createApp();

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

    const res = await app.request("/api/premium/data", {
      headers: { Payment: paymentHeader },
    });

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toContain("asset");
  });

  it("returns 500 when verify function throws", async () => {
    const config: MidenPaywallConfig = {
      ...DEFAULT_CONFIG,
      verifyPayment: async () => {
        throw new Error("Unexpected verify crash");
      },
    };

    const app = createApp(config);
    const paymentHeader = makePaymentHeader();

    const res = await app.request("/api/premium/data", {
      headers: { Payment: paymentHeader },
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("Unexpected verify crash");
  });

  it("accepts overpayment", async () => {
    const app = createApp();

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

    const res = await app.request("/api/premium/data", {
      headers: { Payment: paymentHeader },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBe("premium content");
  });

  it("does not set x-privacy-mode header for public mode", async () => {
    const app = createApp();
    const res = await app.request("/api/premium/data");

    expect(res.status).toBe(402);
    expect(res.headers.get("x-privacy-mode")).toBeNull();
  });

  it("sets x-privacy-mode header for trusted mode", async () => {
    const config: MidenPaywallConfig = {
      ...DEFAULT_CONFIG,
      privacy: "trusted",
    };
    const app = createApp(config);
    const res = await app.request("/api/premium/data");

    expect(res.status).toBe(402);
    expect(res.headers.get("x-privacy-mode")).toBe("trusted");

    const body = await res.json();
    expect(body.accepts[0].privacyMode).toBe("trusted");
  });

  it("rejects trusted mode payment without noteData", async () => {
    const config: MidenPaywallConfig = {
      ...DEFAULT_CONFIG,
      privacy: "trusted",
    };
    const app = createApp(config);
    const paymentHeader = makePaymentHeader(); // no noteData

    const res = await app.request("/api/premium/data", {
      headers: { Payment: paymentHeader },
    });

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toContain("noteData");
  });

  it("throws NotImplemented for encrypted privacy mode", () => {
    expect(() =>
      createApp({ ...DEFAULT_CONFIG, privacy: "encrypted" }),
    ).toThrow("not yet implemented");
  });

  it("throws NotImplemented for zkproof privacy mode", () => {
    expect(() =>
      createApp({ ...DEFAULT_CONFIG, privacy: "zkproof" }),
    ).toThrow("not yet implemented");
  });

  it("works with facilitatorUrl (mocked fetch)", async () => {
    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/verify")) {
        return new Response(
          JSON.stringify({ valid: true, transactionId: "tx_facilitator" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // For Hono's app.request, delegate to original
      return originalFetch(url, init);
    });

    // We can't easily mock fetch for Hono's internal test client,
    // so test the facilitator path directly via core
    const { verifyPayment } = await import("../core.js");

    vi.stubGlobal("fetch", mockFetch);

    const config: MidenPaywallConfig = {
      price: "1000",
      asset: "0xabc123faucet",
      recipient: "0xdef456recipient",
      network: "miden:testnet",
      facilitatorUrl: "http://localhost:4402",
    };

    const payload = {
      x402Version: 2 as const,
      accepted: {
        scheme: "exact" as const,
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
    };

    const result = await verifyPayment(payload, config);
    expect(result.valid).toBe(true);

    vi.unstubAllGlobals();
  });
});
