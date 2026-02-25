/**
 * x402 Miden Middleware
 *
 * Express and Hono middleware for adding Miden x402 payment walls to any route.
 * One line to add a paywall:
 *
 * ```ts
 * app.use('/api/premium', midenPaywall({ price: '1000', asset, recipient }))
 * ```
 *
 * Wire-format types are compatible with x402-miden-agent-sdk.
 *
 * @packageDocumentation
 */

// Core logic (framework-agnostic)
export {
  buildPaymentRequired,
  extractPayment,
  validatePaymentPayload,
  verifyPayment,
  extractPaymentInfo,
} from "./core.js";

// Types
export type {
  MidenPaywallConfig,
  PaymentRequiredBody,
  VerifyRequest,
  VerifyResponse,
  SettleRequest,
  SettleResponse,
  VerifyPaymentFn,
  PaymentInfo,
  ResourceInfoLite,
  MidenPaymentRequirements,
  V2PaymentPayload,
  MidenExactPayload,
} from "./types.js";
