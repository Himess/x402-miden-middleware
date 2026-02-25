/**
 * Express middleware for x402 Miden payment walls.
 *
 * @example
 * ```ts
 * import express from "express";
 * import { midenPaywall } from "x402-miden-middleware/express";
 *
 * const app = express();
 *
 * app.use("/api/premium", midenPaywall({
 *   price: "1000",
 *   asset: "0xfaucetId...",
 *   recipient: "0xmyAccountId...",
 *   network: "miden:testnet",
 *   facilitatorUrl: "http://localhost:4402",
 * }));
 *
 * app.get("/api/premium/data", (req, res) => {
 *   // Only reachable after valid payment
 *   const payment = req.paymentInfo; // { transactionId, from, amount, asset }
 *   res.json({ data: "premium content", paidBy: payment?.from });
 * });
 * ```
 *
 * @module
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { MidenPaywallConfig, PaymentInfo } from "./types.js";
import {
  buildPaymentRequired,
  extractPayment,
  verifyPayment,
  extractPaymentInfo,
  validateConfig,
} from "./core.js";

// Extend Express Request to include paymentInfo
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      paymentInfo?: PaymentInfo;
    }
  }
}

/**
 * Creates an Express middleware that puts a Miden x402 paywall on a route.
 *
 * Requests without a valid `Payment` header get a 402 response.
 * Requests with a valid, verified payment header pass through to the next handler
 * with `req.paymentInfo` populated.
 */
export function midenPaywall(config: MidenPaywallConfig): RequestHandler {
  validateConfig(config);

  return async (req: Request, res: Response, next: NextFunction) => {
    const paymentHeader = req.headers["payment"] as string | undefined;

    // No payment header → return 402
    if (!paymentHeader) {
      const requestUrl = `${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`;
      const body = buildPaymentRequired(config, requestUrl, req.method);

      res.status(402).json(body);
      return;
    }

    // Decode the payment header
    const payload = extractPayment(paymentHeader);
    if (!payload) {
      res.status(400).json({ error: "Invalid Payment header encoding" });
      return;
    }

    // Verify with facilitator
    try {
      const result = await verifyPayment(payload, config);

      if (!result.valid) {
        res.status(402).json({
          error: result.error ?? "Payment verification failed",
          x402Version: 2,
        });
        return;
      }

      // Attach payment info to request for downstream handlers
      req.paymentInfo = extractPaymentInfo(payload);

      next();
    } catch (err) {
      res.status(500).json({
        error: `Payment verification error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };
}

// Re-export types for convenience
export type { MidenPaywallConfig, PaymentInfo } from "./types.js";
