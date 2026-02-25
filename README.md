# x402-miden-middleware

Express and Hono middleware for [x402](https://www.x402.org) payment walls on [Miden](https://miden.xyz). One line to paywall any route with private ZK payments.

## Install

```bash
npm install x402-miden-middleware
```

## Quick Start

### Express

```typescript
import express from "express";
import { midenPaywall } from "x402-miden-middleware/express";

const app = express();

// One line — paywall any route
app.use("/api/premium", midenPaywall({
  price: "1000",
  asset: "0xfaucetAccountId",
  recipient: "0xYourMidenAccountId",
  network: "miden:testnet",
  facilitatorUrl: "http://localhost:4402",
}));

app.get("/api/premium/data", (req, res) => {
  // Only reachable after valid payment
  const payment = req.paymentInfo;
  res.json({
    data: "premium content",
    paidBy: payment?.from,
    txId: payment?.transactionId,
  });
});

app.listen(3000);
```

### Hono

```typescript
import { Hono } from "hono";
import { midenPaywall } from "x402-miden-middleware/hono";

const app = new Hono();

app.use("/api/premium/*", midenPaywall({
  price: "1000",
  asset: "0xfaucetAccountId",
  recipient: "0xYourMidenAccountId",
  network: "miden:testnet",
  facilitatorUrl: "http://localhost:4402",
}));

app.get("/api/premium/data", (c) => {
  const payment = c.get("paymentInfo");
  return c.json({ data: "premium content", paidBy: payment?.from });
});

export default app;
```

## How It Works

```
Client (AI Agent)              Your Server                  Facilitator
     │                            │                            │
     │─── GET /api/premium ──────▶│                            │
     │                            │                            │
     │◀── 402 Payment Required ──│                            │
     │    { accepts: [{           │                            │
     │      scheme: "exact",      │                            │
     │      network: "miden:testnet",                          │
     │      amount: "1000",       │                            │
     │      asset: "0xfaucet",    │                            │
     │      payTo: "0xrecipient"  │                            │
     │    }] }                    │                            │
     │                            │                            │
     │── Create P2ID payment ────────────────────────────────▶│
     │   (STARK proof, no network submission)                  │
     │                            │                            │
     │─── GET /api/premium ──────▶│                            │
     │    Payment: <base64>       │─── POST /verify ─────────▶│
     │                            │◀── { valid: true } ───────│
     │◀── 200 + Data ───────────│                            │
```

1. Request without `Payment` header → middleware returns **402** with payment requirements
2. Client creates a Miden P2ID payment (using [x402-miden-agent-sdk](https://github.com/Himess/x402-miden-agent-sdk))
3. Request with `Payment` header → middleware verifies via facilitator → passes through

## Configuration

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `price` | `string` | Yes | — | Amount in token's smallest unit |
| `asset` | `string` | Yes | — | Token faucet account ID (hex) |
| `recipient` | `string` | Yes | — | Your Miden account ID (hex) |
| `network` | `string` | No | `"miden:testnet"` | CAIP-2 network identifier |
| `facilitatorUrl` | `string` | No | — | Remote facilitator URL |
| `verifyPayment` | `function` | No | — | Custom verify function (overrides facilitatorUrl) |
| `maxTimeoutSeconds` | `number` | No | `300` | Payment validity window |
| `description` | `string` | No | — | Human-readable description for 402 response |

## Payment Verification

Three modes (in priority order):

1. **Custom function** — `verifyPayment: async (payload) => ({ valid: true })`
2. **Remote facilitator** — `facilitatorUrl: "http://localhost:4402"` → sends POST to `/verify`
3. **Dev mode** — No config → accepts with console warning (not for production)

## Accessing Payment Info

After successful verification, payment info is available in downstream handlers:

```typescript
// Express: req.paymentInfo
// Hono: c.get("paymentInfo")

interface PaymentInfo {
  transactionId: string;  // Miden transaction ID
  from: string;           // Sender's account ID
  amount: string;         // Amount paid
  asset: string;          // Token faucet ID
}
```

## Wire Format

The `Payment` header is a base64-encoded JSON payload compatible with [x402-miden-agent-sdk](https://github.com/Himess/x402-miden-agent-sdk):

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "exact",
    "network": "miden:testnet",
    "amount": "1000",
    "payTo": "0xrecipient",
    "asset": "0xfaucet",
    "maxTimeoutSeconds": 300
  },
  "payload": {
    "from": "0xsender",
    "provenTransaction": "hex-encoded-stark-proven-tx",
    "transactionId": "hex-tx-id"
  }
}
```

## Related Packages

- [x402-miden-agent-sdk](https://github.com/Himess/x402-miden-agent-sdk) — Client-side: agent wallets + automatic 402 payment
- [x402-chain-miden](https://github.com/Himess/x402-chain-miden) — Rust: Miden settlement layer for x402

## License

Apache-2.0
