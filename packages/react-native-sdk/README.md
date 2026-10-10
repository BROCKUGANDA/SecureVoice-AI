# @securevoice/react-native-sdk

A thin React Native / JS client for the SecureVoice AI guardrailed voice agent.

It does exactly two things and never re-implements server logic:

- **`createSession(cfg, type)`** — mints a short-lived credential from the
  server (`POST /api/elevenlabs/signed-url`), so the ElevenLabs API key never
  leaves the server. Returns a WebSocket `signed_url` or a WebRTC `token`
  depending on `type`; re-mints every ~15 minutes.
- **`agentTools`** — calls the guardrailed tool surface
  (`POST /api/elevenlabs/tools/*`). The SERVER enforces the tool secret, tenant
  scoping, and state preconditions; this client only carries the shared tool
  secret and forwards the call.

No native dependency. Only `fetch` + `WebSocket` (globalThis), so it type-checks
and runs in React Native and the web alike.

## Install / use (monorepo)

```ts
import { createSession, agentTools } from "@securevoice/react-native-sdk";

const cfg = { baseUrl: "https://app.example.com", toolSecret: "<shared-tool-secret>" };

const session = await createSession(cfg, "websocket"); // session.data.credential → wss://…

await agentTools.verifyTransaction(cfg, conversationId, "confirmed_fraud");
await agentTools.freezeCard(cfg, conversationId, "acct_2381120", "fraud_no_conversation"); // always staged, never committed
await agentTools.warmTransfer(cfg, conversationId, "suspected takeover");
```

## React hook

```tsx
import { useSecureVoiceSession } from "@securevoice/react-native-sdk";

const { session, error, loading } = useSecureVoiceSession(cfg);
```

See `src/securevoice.ts` for the full tool surface and `tests/sdk.test.ts` for the
transport contract.

## Guardrails, unchanged

A privileged action attempted from an untrusted caller's device is still refused
server-side: `card_freeze` only stages a reversible freeze, and the same secret

- tool scope + state-machine rules that guard the browser path guard this one.
