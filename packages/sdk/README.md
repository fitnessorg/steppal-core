# `@steppal/sdk`

Zero-dependency TypeScript client for the StepPal HTTP API, designed for React Native (Hermes), web browsers, and Node.js 20+.

## Features

- **Automatic Token Rotation**: Transparently intercepts `401` responses, rotates the refresh token via `POST /v1/auth/refresh`, deduplicates concurrent refresh requests, and retries the original call once.
- **Cursor-Paginated Pot Listing**: `listPots({ limit, cursor })` supports cursor pagination while remaining backward-compatible with `listPots()`.
- **Offline Step Submission Queue**: `submitSteps(days)` automatically queues step claims locally when a network connectivity failure occurs, deduplicating by calendar `day`, and replays them idempotently via `flushStepQueue()`.
- **Non-Custodial Payment Helpers**: `initializePayment`, `verifyPayment`, `disbursePayout`, `isPaymentComplete`, and `isPaymentSuccessful`.

## Usage

```ts
import { StepPalClient } from "@steppal/sdk";

const client = new StepPalClient({
  baseUrl: "http://localhost:3000",
  getTokens: () => storedTokens, // read from SecureStore / Keychain
  onStepQueueChange: (queue) => persist(queue), // e.g. AsyncStorage
});

await client.requestCode("08031234567");
const session = await client.verifyCode("08031234567", "418245", "Ada");

const pots = await client.listPots({ limit: 20 });
await client.submitSteps([{ day: "2026-03-10", steps: 9500, source: "pedometer" }]);
```
