/**
 * Core x402 payment verification logic shared between Express and Hono middleware.
 *
 * Handles:
 * - Building 402 Payment Required responses
 * - Decoding Payment headers
 * - Verifying payments via facilitator (remote or inline)
 * - Replay protection via LRU transaction ID dedup
 */

import { z } from "zod";
import type {
  MidenPaywallConfig,
  MidenPaymentRequirements,
  V2PaymentPayload,
  PaymentRequiredBody,
  VerifyResponse,
  PaymentInfo,
  PaywallLogger,
} from "./types.js";

// ============================================================================
// Zod Schema for Payment Payload
// ============================================================================

const PaymentPayloadSchema = z.object({
  x402Version: z.literal(2),
  accepted: z.object({
    scheme: z.string(),
    network: z.string(),
    amount: z.string(),
    payTo: z.string(),
    maxTimeoutSeconds: z.number().positive().optional(),
    asset: z.string(),
    privacyMode: z.string().optional(),
  }),
  payload: z.object({
    from: z.string(),
    provenTransaction: z.string(),
    transactionId: z.string(),
    noteData: z.string().optional(),
  }),
  resource: z.object({ url: z.string(), method: z.string() }).optional(),
});

/** Default logger — falls back to console. */
const defaultLogger: PaywallLogger = {
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
};

/** Resolves the logger from config, defaulting to console. */
export function resolveLogger(config: MidenPaywallConfig): PaywallLogger {
  return config.logger ?? defaultLogger;
}

// ============================================================================
// Replay Guard
// ============================================================================

/**
 * Creates an in-memory LRU-like replay guard that tracks seen transaction IDs.
 *
 * When the map exceeds `maxSize`, the oldest entry is evicted (FIFO via Map iteration order).
 *
 * @param maxSize Maximum number of transaction IDs to retain. Defaults to 10000.
 */
export function createReplayGuard(maxSize = 10000) {
  const seen = new Map<string, number>();
  return {
    /**
     * Checks whether a transaction ID has already been seen.
     *
     * @returns `true` if the transaction is new (allowed), `false` if it is a replay.
     */
    check(transactionId: string): boolean {
      if (seen.has(transactionId)) return false;
      if (seen.size >= maxSize) {
        // Evict oldest entry (first key in Map iteration order)
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
      seen.set(transactionId, Date.now());
      return true;
    },
  };
}

// ============================================================================
// URL-safe Base64 Decoding
// ============================================================================

/**
 * Decodes a base64 string, handling URL-safe base64 variants.
 *
 * Converts `-` to `+`, `_` to `/`, and adds padding if needed before calling `atob`.
 */
function decodeBase64(encoded: string): string {
  // Handle URL-safe base64
  let standard = encoded.replace(/-/g, "+").replace(/_/g, "/");
  // Add padding if needed
  while (standard.length % 4 !== 0) standard += "=";
  return atob(standard);
}

// ============================================================================
// Circuit Breaker
// ============================================================================

/**
 * Creates a simple circuit breaker for facilitator requests.
 *
 * - **closed**: Normal operation. Requests pass through.
 * - **open**: Too many failures. Requests are blocked until `resetTimeMs` elapses.
 * - **half-open**: After reset time, allows one request to test recovery.
 */
export function createCircuitBreaker(
  options: { failureThreshold?: number; resetTimeMs?: number } = {},
) {
  const threshold = options.failureThreshold ?? 5;
  const resetTime = options.resetTimeMs ?? 30000;
  let failures = 0;
  let lastFailure = 0;
  let state: "closed" | "open" | "half-open" = "closed";

  return {
    get state() {
      return state;
    },
    recordSuccess() {
      failures = 0;
      state = "closed";
    },
    recordFailure() {
      failures++;
      lastFailure = Date.now();
      if (failures >= threshold) state = "open";
    },
    canRequest(): boolean {
      if (state === "closed") return true;
      if (state === "open" && Date.now() - lastFailure >= resetTime) {
        state = "half-open";
        return true;
      }
      return state === "half-open";
    },
  };
}

// ============================================================================
// Facilitator Fetch with Retry
// ============================================================================

/**
 * Fetches a URL with exponential backoff retry logic.
 *
 * Only retries on network errors and 5xx responses. 4xx responses are returned immediately.
 * Abort errors are re-thrown without retrying.
 */
async function fetchWithRetry(
  url: string,
  opts: RequestInit,
  maxRetries: number,
  signal: AbortSignal,
  logger: PaywallLogger,
): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { ...opts, signal });
      if (res.ok || res.status < 500) return res;
      lastError = new Error(`Facilitator returned ${res.status}`);
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        logger.warn(
          `Facilitator returned ${res.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        logger.warn(
          `Facilitator fetch failed, retrying in ${delay}ms: ${lastError.message}`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError ?? new Error("Facilitator request failed after retries");
}

// ============================================================================
// Payment Required Response Builder
// ============================================================================

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
  const privacy = config.privacy ?? "public";

  const requirements: MidenPaymentRequirements = {
    scheme: "exact",
    network: config.network ?? "miden:testnet",
    amount: config.price,
    payTo: config.recipient,
    maxTimeoutSeconds: config.maxTimeoutSeconds ?? 300,
    asset: config.asset,
    // Only include privacyMode when non-default (keeps backward compat for 'public')
    ...(privacy !== "public" ? { privacyMode: privacy } : {}),
  };

  return {
    x402Version: 2,
    accepts: [requirements],
    resource: { url: requestUrl, method: requestMethod },
    error: config.description ?? "Payment required to access this resource",
  };
}

// ============================================================================
// Payment Header Extraction
// ============================================================================

/** Maximum allowed Payment header length (64 KB). Prevents base64 decode DoS. */
const MAX_PAYMENT_HEADER_LENGTH = 65536;

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

  // Reject oversized Payment headers to prevent base64 decode DoS.
  // 64 KB is generous for any legitimate payment payload.
  if (paymentHeader.length > MAX_PAYMENT_HEADER_LENGTH) {
    return null;
  }

  try {
    const json = decodeBase64(paymentHeader);
    const parsed = JSON.parse(json);

    // Validate with zod schema
    const result = PaymentPayloadSchema.safeParse(parsed);
    if (!result.success) return null;

    return result.data as unknown as V2PaymentPayload;
  } catch {
    return null;
  }
}

// ============================================================================
// Payment Payload Validation
// ============================================================================

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
  let paidAmount: bigint;
  let requiredAmount: bigint;
  try {
    paidAmount = BigInt(accepted.amount);
    requiredAmount = BigInt(config.price);
  } catch {
    return { valid: false, error: `Invalid amount format: "${accepted.amount}" or "${config.price}"` };
  }

  if (paidAmount < requiredAmount) {
    return {
      valid: false,
      error: `Insufficient payment: required ${config.price}, got ${accepted.amount}`,
    };
  }

  // Validate maxTimeoutSeconds if present
  if (accepted.maxTimeoutSeconds !== undefined) {
    if (typeof accepted.maxTimeoutSeconds !== "number" || accepted.maxTimeoutSeconds <= 0) {
      return { valid: false, error: "maxTimeoutSeconds must be a positive number" };
    }
  }

  // Check payload has required fields (non-empty)
  if (!payload.payload?.provenTransaction?.trim() || !payload.payload?.transactionId?.trim()) {
    return { valid: false, error: "Missing proven transaction data" };
  }

  // For 'trusted' privacy mode, noteData is required in the payment payload
  const privacy = config.privacy ?? "public";
  if (privacy === "trusted") {
    if (!payload.payload?.noteData?.trim()) {
      return {
        valid: false,
        error: "Missing noteData: trusted privacy mode requires off-chain note data in the payment payload",
      };
    }
  }

  return { valid: true };
}

// ============================================================================
// Config Validation
// ============================================================================

/**
 * Validates the middleware configuration at creation time.
 * Throws if config is invalid.
 */
export function validateConfig(config: MidenPaywallConfig): void {
  if (!config.price || !config.price.trim()) {
    throw new Error("midenPaywall: price is required");
  }
  try {
    const amount = BigInt(config.price);
    if (amount <= 0n) {
      throw new Error("midenPaywall: price must be positive");
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("midenPaywall:")) throw err;
    throw new Error(`midenPaywall: invalid price "${config.price}" — must be a valid integer string`);
  }

  if (!config.asset || !config.asset.trim()) {
    throw new Error("midenPaywall: asset (faucet ID) is required");
  }
  if (!config.recipient || !config.recipient.trim()) {
    throw new Error("midenPaywall: recipient (account ID) is required");
  }

  // Validate privacy mode
  const privacy = config.privacy ?? "public";
  const validModes = ["public", "trusted", "encrypted", "zkproof"];
  if (!validModes.includes(privacy)) {
    throw new Error(`midenPaywall: invalid privacy mode "${privacy}". Must be one of: ${validModes.join(", ")}`);
  }
  if (privacy === "encrypted") {
    throw new Error("midenPaywall: privacy mode 'encrypted' is not yet implemented. Use 'public' or 'trusted'.");
  }
  if (privacy === "zkproof") {
    throw new Error("midenPaywall: privacy mode 'zkproof' is not yet implemented. Use 'public' or 'trusted'.");
  }
}

// ============================================================================
// Payment Verification
// ============================================================================

/**
 * Verifies a payment with the facilitator.
 *
 * Uses either:
 * - A custom verify function (for testing or inline verification)
 * - A remote facilitator URL (for production)
 * - Rejects if neither is configured (secure by default)
 *
 * When using a remote facilitator, the optional `circuitBreaker` parameter
 * controls whether requests are blocked after repeated failures.
 */
export async function verifyPayment(
  payload: V2PaymentPayload,
  config: MidenPaywallConfig,
  circuitBreaker?: ReturnType<typeof createCircuitBreaker>,
): Promise<VerifyResponse> {
  const log = resolveLogger(config);

  // First: validate the payload locally
  const localValidation = validatePaymentPayload(payload, config);
  if (!localValidation.valid) {
    log.warn("Payment verification failed (local validation)", localValidation.error);
    return { valid: false, error: localValidation.error };
  }

  // Custom verify function takes priority
  if (config.verifyPayment) {
    try {
      const result = await config.verifyPayment(payload);
      if (result.valid) {
        log.info("Payment verified successfully", payload.payload.transactionId);
      } else {
        log.warn("Payment verification failed", result.error);
      }
      return result;
    } catch (err) {
      log.error("Verification threw an error", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  // Remote facilitator
  if (config.facilitatorUrl) {
    // Circuit breaker check
    if (circuitBreaker && !circuitBreaker.canRequest()) {
      log.warn("Circuit breaker open — facilitator requests blocked");
      return {
        valid: false,
        error: "Payment verification temporarily unavailable",
      };
    }

    try {
      const result = await verifyWithFacilitator(payload, config.facilitatorUrl, config);
      if (circuitBreaker) {
        if (result.valid) {
          circuitBreaker.recordSuccess();
        } else {
          circuitBreaker.recordFailure();
        }
      }
      return result;
    } catch (err) {
      if (circuitBreaker) circuitBreaker.recordFailure();
      throw err;
    }
  }

  // No facilitator configured — reject by default (secure)
  log.warn("Payment verification failed", "No facilitator configured");
  return {
    valid: false,
    error:
      "No facilitator configured. Set facilitatorUrl or verifyPayment to enable payment verification.",
  };
}

/**
 * Sends verification request to a remote facilitator service.
 *
 * Uses an AbortController to enforce a timeout and exponential backoff retry logic.
 */
async function verifyWithFacilitator(
  payload: V2PaymentPayload,
  facilitatorUrl: string,
  config: MidenPaywallConfig,
): Promise<VerifyResponse> {
  const log = resolveLogger(config);
  const url = `${facilitatorUrl.replace(/\/$/, "")}/verify`;
  const timeoutMs = config.verifyTimeoutMs ?? 10000;
  const maxRetries = config.maxRetries ?? 3;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload }),
      },
      maxRetries,
      controller.signal,
      log,
    );

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const truncated = text.length > 500 ? text.slice(0, 500) + "..." : text;
      log.warn("Payment verification failed", `Facilitator returned ${response.status}`);
      return {
        valid: false,
        error: `Facilitator returned ${response.status}: ${truncated}`,
      };
    }

    const result = (await response.json()) as VerifyResponse;
    if (result.valid) {
      log.info("Payment verified successfully", payload.payload.transactionId);
    } else {
      log.warn("Payment verification failed", result.error);
    }
    return result;
  } catch (err) {
    log.error("Facilitator unreachable", err instanceof Error ? err.message : String(err));
    return {
      valid: false,
      error: `Facilitator unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// Payment Info Extraction
// ============================================================================

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
