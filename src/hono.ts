/**
 * Hono middleware for x402 Miden payment walls.
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { midenPaywall } from "x402-miden-middleware/hono";
 *
 * const app = new Hono();
 *
 * app.use("/api/premium/*", midenPaywall({
 *   price: "1000",
 *   asset: "0xfaucetId...",
 *   recipient: "0xmyAccountId...",
 *   network: "miden:testnet",
 *   facilitatorUrl: "http://localhost:4402",
 * }));
 *
 * app.get("/api/premium/data", (c) => {
 *   const payment = c.get("paymentInfo"); // { transactionId, from, amount, asset }
 *   return c.json({ data: "premium content", paidBy: payment?.from });
 * });
 * ```
 *
 * @module
 */

import type { Context, MiddlewareHandler } from "hono";
import type { MidenPaywallConfig, PaymentInfo } from "./types.js";
import {
  buildPaymentRequired,
  extractPayment,
  verifyPayment,
  extractPaymentInfo,
} from "./core.js";

// Hono environment type augmentation for paymentInfo
export type PaymentEnv = {
  Variables: {
    paymentInfo: PaymentInfo;
  };
};

/**
 * Creates a Hono middleware that puts a Miden x402 paywall on a route.
 *
 * Requests without a valid `Payment` header get a 402 response.
 * Requests with a valid, verified payment header pass through to the next handler
 * with `c.get("paymentInfo")` populated.
 */
export function midenPaywall(config: MidenPaywallConfig): MiddlewareHandler {
  return async (c: Context, next) => {
    const paymentHeader = c.req.header("payment");

    // No payment header → return 402
    if (!paymentHeader) {
      const body = buildPaymentRequired(config, c.req.url, c.req.method);
      return c.json(body, 402);
    }

    // Decode the payment header
    const payload = extractPayment(paymentHeader);
    if (!payload) {
      return c.json({ error: "Invalid Payment header encoding" }, 400);
    }

    // Verify with facilitator
    try {
      const result = await verifyPayment(payload, config);

      if (!result.valid) {
        return c.json(
          {
            error: result.error ?? "Payment verification failed",
            x402Version: 2,
          },
          402,
        );
      }

      // Attach payment info to context for downstream handlers
      c.set("paymentInfo", extractPaymentInfo(payload));

      await next();
    } catch (err) {
      return c.json(
        {
          error: `Payment verification error: ${err instanceof Error ? err.message : String(err)}`,
        },
        500,
      );
    }
  };
}

// Re-export types for convenience
export type { MidenPaywallConfig, PaymentInfo } from "./types.js";
