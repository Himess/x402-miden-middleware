import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildPaymentRequired,
  extractPayment,
  validatePaymentPayload,
  verifyPayment,
  extractPaymentInfo,
} from "../core.js";
import type { MidenPaywallConfig, V2PaymentPayload } from "../types.js";

// ============================================================================
// Test helpers
// ============================================================================

const DEFAULT_CONFIG: MidenPaywallConfig = {
  price: "1000",
  asset: "0xabc123faucet",
  recipient: "0xdef456recipient",
  network: "miden:testnet",
};

function makeValidPayload(
  overrides: Partial<V2PaymentPayload> = {},
): V2PaymentPayload {
  return {
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
}

// ============================================================================
// buildPaymentRequired
// ============================================================================

describe("buildPaymentRequired", () => {
  it("builds a valid 402 response body", () => {
    const body = buildPaymentRequired(
      DEFAULT_CONFIG,
      "https://api.example.com/premium",
      "GET",
    );

    expect(body.x402Version).toBe(2);
    expect(body.accepts).toHaveLength(1);
    expect(body.accepts[0].scheme).toBe("exact");
    expect(body.accepts[0].network).toBe("miden:testnet");
    expect(body.accepts[0].amount).toBe("1000");
    expect(body.accepts[0].payTo).toBe("0xdef456recipient");
    expect(body.accepts[0].asset).toBe("0xabc123faucet");
    expect(body.accepts[0].maxTimeoutSeconds).toBe(300);
  });

  it("uses default network when not specified", () => {
    const config: MidenPaywallConfig = {
      price: "500",
      asset: "0xfaucet",
      recipient: "0xrecipient",
    };
    const body = buildPaymentRequired(config, "/api/data", "POST");
    expect(body.accepts[0].network).toBe("miden:testnet");
  });

  it("uses custom maxTimeoutSeconds", () => {
    const config: MidenPaywallConfig = {
      ...DEFAULT_CONFIG,
      maxTimeoutSeconds: 600,
    };
    const body = buildPaymentRequired(config, "/api/data", "GET");
    expect(body.accepts[0].maxTimeoutSeconds).toBe(600);
  });

  it("includes description as error field", () => {
    const config: MidenPaywallConfig = {
      ...DEFAULT_CONFIG,
      description: "Pay 1000 units to read this article",
    };
    const body = buildPaymentRequired(config, "/api/data", "GET");
    expect(body.error).toBe("Pay 1000 units to read this article");
  });
});

// ============================================================================
// extractPayment
// ============================================================================

describe("extractPayment", () => {
  it("returns null for null/undefined header", () => {
    expect(extractPayment(null)).toBeNull();
    expect(extractPayment(undefined)).toBeNull();
    expect(extractPayment("")).toBeNull();
  });

  it("returns null for invalid base64", () => {
    expect(extractPayment("not-valid-base64!!!")).toBeNull();
  });

  it("returns null for valid base64 but invalid JSON", () => {
    const encoded = btoa("not json at all");
    expect(extractPayment(encoded)).toBeNull();
  });

  it("decodes a valid payment header", () => {
    const payload = makeValidPayload();
    const encoded = btoa(JSON.stringify(payload));

    const decoded = extractPayment(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.x402Version).toBe(2);
    expect(decoded!.payload.transactionId).toBe("tx_001");
  });
});

// ============================================================================
// validatePaymentPayload
// ============================================================================

describe("validatePaymentPayload", () => {
  it("accepts a valid payload", () => {
    const result = validatePaymentPayload(
      makeValidPayload(),
      DEFAULT_CONFIG,
    );
    expect(result.valid).toBe(true);
  });

  it("rejects wrong scheme", () => {
    const payload = makeValidPayload();
    (payload.accepted as Record<string, unknown>).scheme = "upto";
    const result = validatePaymentPayload(payload, DEFAULT_CONFIG);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("scheme");
  });

  it("rejects wrong network", () => {
    const payload = makeValidPayload();
    payload.accepted.network = "miden:mainnet";
    const result = validatePaymentPayload(payload, DEFAULT_CONFIG);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("network");
  });

  it("rejects wrong asset", () => {
    const payload = makeValidPayload();
    payload.accepted.asset = "0xwrongfaucet";
    const result = validatePaymentPayload(payload, DEFAULT_CONFIG);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("asset");
  });

  it("rejects wrong recipient", () => {
    const payload = makeValidPayload();
    payload.accepted.payTo = "0xwrongrecipient";
    const result = validatePaymentPayload(payload, DEFAULT_CONFIG);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("recipient");
  });

  it("rejects insufficient amount", () => {
    const payload = makeValidPayload();
    payload.accepted.amount = "500"; // required is 1000
    const result = validatePaymentPayload(payload, DEFAULT_CONFIG);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Insufficient");
  });

  it("accepts overpayment", () => {
    const payload = makeValidPayload();
    payload.accepted.amount = "2000"; // required is 1000
    const result = validatePaymentPayload(payload, DEFAULT_CONFIG);
    expect(result.valid).toBe(true);
  });

  it("rejects missing provenTransaction", () => {
    const payload = makeValidPayload();
    payload.payload.provenTransaction = "";
    const result = validatePaymentPayload(payload, DEFAULT_CONFIG);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("proven transaction");
  });

  it("rejects missing transactionId", () => {
    const payload = makeValidPayload();
    payload.payload.transactionId = "";
    const result = validatePaymentPayload(payload, DEFAULT_CONFIG);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("proven transaction");
  });
});

// ============================================================================
// verifyPayment
// ============================================================================

describe("verifyPayment", () => {
  it("uses custom verify function when provided", async () => {
    const customVerify = vi.fn().mockResolvedValue({
      valid: true,
      transactionId: "tx_custom",
    });

    const config: MidenPaywallConfig = {
      ...DEFAULT_CONFIG,
      verifyPayment: customVerify,
    };

    const result = await verifyPayment(makeValidPayload(), config);
    expect(result.valid).toBe(true);
    expect(customVerify).toHaveBeenCalledOnce();
  });

  it("rejects locally invalid payloads before calling facilitator", async () => {
    const customVerify = vi.fn();
    const payload = makeValidPayload();
    payload.accepted.asset = "0xwrong";

    const config: MidenPaywallConfig = {
      ...DEFAULT_CONFIG,
      verifyPayment: customVerify,
    };

    const result = await verifyPayment(payload, config);
    expect(result.valid).toBe(false);
    expect(customVerify).not.toHaveBeenCalled();
  });

  it("calls remote facilitator when facilitatorUrl is set", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ valid: true, transactionId: "tx_remote" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const config: MidenPaywallConfig = {
      ...DEFAULT_CONFIG,
      facilitatorUrl: "http://localhost:4402",
    };

    const result = await verifyPayment(makeValidPayload(), config);
    expect(result.valid).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:4402/verify",
      expect.objectContaining({ method: "POST" }),
    );

    vi.unstubAllGlobals();
  });

  it("handles facilitator errors gracefully", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });
    vi.stubGlobal("fetch", mockFetch);

    const config: MidenPaywallConfig = {
      ...DEFAULT_CONFIG,
      facilitatorUrl: "http://localhost:4402",
    };

    const result = await verifyPayment(makeValidPayload(), config);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("500");

    vi.unstubAllGlobals();
  });

  it("handles facilitator network failure", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", mockFetch);

    const config: MidenPaywallConfig = {
      ...DEFAULT_CONFIG,
      facilitatorUrl: "http://localhost:4402",
    };

    const result = await verifyPayment(makeValidPayload(), config);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");

    vi.unstubAllGlobals();
  });

  it("passes through when no facilitator configured (dev mode)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const config: MidenPaywallConfig = {
      price: "1000",
      asset: "0xabc123faucet",
      recipient: "0xdef456recipient",
    };

    const result = await verifyPayment(makeValidPayload(), config);
    expect(result.valid).toBe(true);
    expect(warnSpy).toHaveBeenCalledOnce();

    warnSpy.mockRestore();
  });
});

// ============================================================================
// extractPaymentInfo
// ============================================================================

describe("extractPaymentInfo", () => {
  it("extracts payment info from payload", () => {
    const payload = makeValidPayload();
    const info = extractPaymentInfo(payload);

    expect(info.transactionId).toBe("tx_001");
    expect(info.from).toBe("0xsender123");
    expect(info.amount).toBe("1000");
    expect(info.asset).toBe("0xabc123faucet");
  });
});
