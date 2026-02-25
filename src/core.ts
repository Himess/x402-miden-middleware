/**
 * Core x402 payment verification logic shared between Express and Hono middleware.
 *
 * Handles:
 * - Building 402 Payment Required responses
 * - Decoding Payment headers
 * - Verifying payments via facilitator (remote or inline)
 */

import type {
  MidenPaywallConfig,
  MidenPaymentRequirements,
  V2PaymentPayload,
  PaymentRequiredBody,
  VerifyResponse,
  PaymentInfo,
} from "./types.js";

/**
 * Builds the 402 Payment Required response body.
 *
 * Contains the payment requirements that the client must fulfill.
 */
export function buildPaymentRequired(
  config: MidenPaywallConfig,
  requestUrl: string,
  requestMethod: string,
): PaymentRequiredBody {
  const requirements: MidenPaymentRequirements = {
    scheme: "exact",
    network: config.network ?? "miden:testnet",
    amount: config.price,
    payTo: config.recipient,
    maxTimeoutSeconds: config.maxTimeoutSeconds ?? 300,
    asset: config.asset,
  };

  return {
    x402Version: 2,
    accepts: [requirements],
    error: config.description ?? "Payment required to access this resource",
  };
}

/**
 * Extracts and decodes the Payment header from a request.
 *
 * The Payment header is a base64-encoded JSON V2PaymentPayload.
 *
 * @returns Decoded V2PaymentPayload or null if header is missing/invalid
 */
export function extractPayment(
  paymentHeader: string | null | undefined,
): V2PaymentPayload | null {
  if (!paymentHeader) return null;

  try {
    const json = atob(paymentHeader);
    return JSON.parse(json) as V2PaymentPayload;
  } catch {
    return null;
  }
}

/**
 * Validates that a payment payload matches the expected requirements.
 *
 * Checks:
 * - Scheme is "exact"
 * - Network matches
 * - Amount >= required
 * - Asset matches
 * - Recipient matches
 */
export function validatePaymentPayload(
  payload: V2PaymentPayload,
  config: MidenPaywallConfig,
): { valid: boolean; error?: string } {
  const accepted = payload.accepted;

  if (accepted.scheme !== "exact") {
    return { valid: false, error: "Unsupported payment scheme" };
  }

  const expectedNetwork = config.network ?? "miden:testnet";
  if (accepted.network !== expectedNetwork) {
    return {
      valid: false,
      error: `Wrong network: expected ${expectedNetwork}, got ${accepted.network}`,
    };
  }

  if (accepted.asset !== config.asset) {
    return {
      valid: false,
      error: `Wrong asset: expected ${config.asset}, got ${accepted.asset}`,
    };
  }

  if (accepted.payTo !== config.recipient) {
    return {
      valid: false,
      error: `Wrong recipient: expected ${config.recipient}, got ${accepted.payTo}`,
    };
  }

  // Amount check: paid amount must be >= required amount
  const paidAmount = BigInt(accepted.amount);
  const requiredAmount = BigInt(config.price);
  if (paidAmount < requiredAmount) {
    return {
      valid: false,
      error: `Insufficient payment: required ${config.price}, got ${accepted.amount}`,
    };
  }

  // Check payload has required fields
  if (!payload.payload?.provenTransaction || !payload.payload?.transactionId) {
    return { valid: false, error: "Missing proven transaction data" };
  }

  return { valid: true };
}

/**
 * Verifies a payment with the facilitator.
 *
 * Uses either:
 * - A custom verify function (for testing or inline verification)
 * - A remote facilitator URL (for production)
 * - No verification (if neither is configured — logs warning and passes through)
 */
export async function verifyPayment(
  payload: V2PaymentPayload,
  config: MidenPaywallConfig,
): Promise<VerifyResponse> {
  // First: validate the payload locally
  const localValidation = validatePaymentPayload(payload, config);
  if (!localValidation.valid) {
    return { valid: false, error: localValidation.error };
  }

  // Custom verify function takes priority
  if (config.verifyPayment) {
    return config.verifyPayment(payload);
  }

  // Remote facilitator
  if (config.facilitatorUrl) {
    return verifyWithFacilitator(payload, config.facilitatorUrl);
  }

  // No facilitator configured — accept with warning
  // TODO: In production, this should reject. For development convenience, we pass through.
  console.warn(
    "[x402-miden-middleware] No facilitator configured. " +
      "Payment accepted without on-chain verification. " +
      "Set facilitatorUrl or verifyPayment for production use.",
  );

  return {
    valid: true,
    transactionId: payload.payload.transactionId,
  };
}

/**
 * Sends verification request to a remote facilitator service.
 */
async function verifyWithFacilitator(
  payload: V2PaymentPayload,
  facilitatorUrl: string,
): Promise<VerifyResponse> {
  const url = `${facilitatorUrl.replace(/\/$/, "")}/verify`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload }),
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        valid: false,
        error: `Facilitator returned ${response.status}: ${text}`,
      };
    }

    const result = (await response.json()) as VerifyResponse;
    return result;
  } catch (err) {
    return {
      valid: false,
      error: `Facilitator unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Extracts payment info from a verified payload.
 * Attached to the request object for downstream handlers.
 */
export function extractPaymentInfo(
  payload: V2PaymentPayload,
): PaymentInfo {
  return {
    transactionId: payload.payload.transactionId,
    from: payload.payload.from,
    amount: payload.accepted.amount,
    asset: payload.accepted.asset,
  };
}
