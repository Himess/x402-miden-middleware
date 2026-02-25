/**
 * Configuration and type definitions for x402 Miden middleware.
 *
 * Wire-format types (MidenPaymentRequirements, V2PaymentPayload, MidenExactPayload)
 * are defined here and are compatible with x402-miden-agent-sdk's types.
 * No runtime dependency on the agent SDK — the middleware is server-side only.
 */

// ============================================================================
// Privacy Mode
// ============================================================================

/**
 * Privacy mode for x402 Miden payments.
 *
 * - `'public'` (default): Notes are fully visible on-chain. Backward compatible.
 * - `'trusted'`: Private notes — only hash on-chain. Client shares full note
 *   data with facilitator off-chain via `noteData` in the payment payload.
 *   Server adds `x-privacy-mode: trusted` header to 402 responses.
 * - `'encrypted'`: Reserved for future use (not yet implemented).
 * - `'zkproof'`: Reserved for future use (not yet implemented).
 */
export type PrivacyMode = "public" | "trusted" | "encrypted" | "zkproof";

// ============================================================================
// x402 Wire-Format Types (compatible with x402-miden-agent-sdk)
// ============================================================================

/** Payment requirements from a 402 response (Miden V2 exact scheme). */
export interface MidenPaymentRequirements {
  /** Always "exact" for the Miden exact scheme. */
  scheme: "exact";
  /** CAIP-2 chain ID, e.g. "miden:testnet". */
  network: string;
  /** Payment amount in token's smallest unit (as string). */
  amount: string;
  /** Recipient account ID (hex). */
  payTo: string;
  /** Maximum timeout in seconds. */
  maxTimeoutSeconds: number;
  /** Token faucet account ID (hex). */
  asset: string;
  /** Privacy mode required for this payment. Omitted for 'public' (default). */
  privacyMode?: PrivacyMode;
  /** Optional extra data. */
  extra?: unknown;
}

/** The Miden-specific payload inside a V2 payment. */
export interface MidenExactPayload {
  /** Sender's account ID (hex). */
  from: string;
  /** Hex-encoded serialized ProvenTransaction. */
  provenTransaction: string;
  /** Transaction ID (hex). */
  transactionId: string;
  /** Privacy mode used for this payment. Defaults to "public". */
  privacyMode?: PrivacyMode;
  /** Hex-encoded full Note data for 'trusted' privacy mode (off-chain delivery). */
  noteData?: string;
}

/** Full V2 payment payload for the Payment header. */
export interface V2PaymentPayload {
  x402Version: 2;
  accepted: MidenPaymentRequirements;
  resource?: { url: string; method: string; headers?: Record<string, string> };
  payload: MidenExactPayload;
}

// ============================================================================
// Middleware Configuration Types
// ============================================================================

/** Configuration for the midenPaywall middleware. */
export interface MidenPaywallConfig {
  /** Payment amount in token's smallest unit (string to avoid BigInt serialization issues). */
  price: string;
  /** Token faucet account ID (hex). */
  asset: string;
  /** Recipient's Miden account ID — the server/merchant wallet (hex). */
  recipient: string;
  /** CAIP-2 network identifier. Defaults to "miden:testnet". */
  network?: string;
  /**
   * Privacy mode for payments. Defaults to "public".
   *
   * - `'public'`: Default. Notes fully visible on-chain (backward compatible).
   * - `'trusted'`: Private notes. Adds `x-privacy-mode: trusted` header to 402 responses.
   *   Client must include `noteData` (hex-encoded full Note) in the payment payload.
   * - `'encrypted'`: Not yet implemented. Throws at config validation.
   * - `'zkproof'`: Not yet implemented. Throws at config validation.
   */
  privacy?: PrivacyMode;
  /** Facilitator URL for payment verification. */
  facilitatorUrl?: string;
  /** Custom verify function — overrides facilitator URL. Use for testing or inline verification. */
  verifyPayment?: VerifyPaymentFn;
  /** Maximum timeout in seconds for payment validity. Defaults to 300 (5 min). */
  maxTimeoutSeconds?: number;
  /** Optional description shown to the client about what they're paying for. */
  description?: string;
}

/** Lightweight resource info for 402 response. */
export interface ResourceInfoLite {
  url: string;
  method: string;
}

/** Facilitator verify request. */
export interface VerifyRequest {
  payload: V2PaymentPayload;
}

/** Facilitator verify response. */
export interface VerifyResponse {
  valid: boolean;
  error?: string;
  transactionId?: string;
}

/** Facilitator settle request. */
export interface SettleRequest {
  payload: V2PaymentPayload;
}

/** Facilitator settle response. */
export interface SettleResponse {
  settled: boolean;
  transactionId?: string;
  error?: string;
}

/** Custom verify function signature. */
export type VerifyPaymentFn = (
  payload: V2PaymentPayload,
) => Promise<VerifyResponse>;

/** The 402 response body (what the server returns to the client). */
export interface PaymentRequiredBody {
  x402Version: 2;
  accepts: MidenPaymentRequirements[];
  resource?: { url: string; method: string };
  error?: string;
}

/** Payment verification result attached to the request for downstream handlers. */
export interface PaymentInfo {
  transactionId: string;
  from: string;
  amount: string;
  asset: string;
}
