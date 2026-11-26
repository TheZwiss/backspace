# Private Message Translation System

Source files:
- `packages/shared/src/translation.ts` — Shared protocols, target languages, wire interfaces, size/cache bounds
- `packages/server/drizzle/0032_ai_translation.sql` — Schema migration (`ai_translation_provider`, `ai_translation_preferences`, `ai_translation_cache`, `purge_deleted_user_translation` trigger)
- `packages/server/src/translation/encryption.ts` & `encryptionKey.ts` — AES-256-GCM at-rest encryption with context-bound AAD and automatic key management (`AI_TRANSLATION_ENCRYPTION_KEY` or `0600` sibling keyfile)
- `packages/server/src/translation/providerFetch.ts` — Public-HTTPS validation, DNS private/loopback/link-local SSRF blocking, `redirect: 'error'`, response size cap (512 KiB), timeout (20 s)
- `packages/server/src/translation/textPolicy.ts` — Linear-time masking and strict post-translation restoration of code spans/fences, URLs, emails, Backspace mention tokens, and sticker tokens
- `packages/server/src/translation/aiProtocols.ts` & `prompt.ts` — Minimal-payload adapters for `openai-chat`, `openai-responses`, `anthropic`, and `gemini`
- `packages/server/src/translation/storage.ts` — Single-provider persistence, fingerprint-bound user consent, and per-user/per-instance encrypted LRU cache
- `packages/server/src/routes/translation.ts` — Admin configuration routes (`/api/admin/translation*`) and authenticated user routes (`/api/translation/*`)
- `packages/web/src/features/translation/` — Origin-scoped client store, first-transfer consent disclosure modal, plain-text translation renderer, and user privacy controls
- `packages/web/src/components/modals/instanceSettingsPanels/TranslationAdminPanel.tsx` — Instance administrator configuration UI

---

## 1. Supported Scope

Message translation in Backspace follows five strict first-scope invariants:

1. **Single message on an explicit user action:** Only an explicit `Translate Message` click in a message's context menu triggers a translation request. There is no background auto-translation, no bulk history translation, no composer writing assistant, and no conversation summarization.
2. **Off by default:** Fresh instances have no configured provider and `enabled = false`. No UI action appears on messages until an administrator configures and enables a provider.
3. **One administrator-configured provider per instance:** Stored as singleton row `id = 1` in `ai_translation_provider`. Individual users never supply or manage API keys.
4. **Server-side credentials only:** Provider API keys live exclusively on the server, encrypted at rest with AES-256-GCM (`AAD = v1|provider-key|<instanceId>`), and are never returned over any API response. Changing `baseUrl` or `protocol` requires supplying a fresh API key so an existing stored key can never be pointed at a new host.
5. **Identical Web and Desktop boundary:** Because the Electron desktop app renders `packages/web` against the connected instance's HTTP API, both Web and Desktop share the exact same server-enforced consent gate, origin routing, and credential isolation with zero desktop-specific IPC or local credential storage.

---

## 2. First-Transfer Disclosure & Consent Enforcement

Before the first message text is sent to an instance's configured provider, the user must explicitly accept the disclosure for that instance and provider:

- `GET /api/translation/status` returns `{ enabled, provider: { label, host, fingerprint }, preferences }` where `fingerprint = SHA-256([instanceId, protocol, providerHost])`.
- When a user clicks `Translate Message` while `preferences.consented === false`, the client opens `TranslationConsentModal` naming `provider.label` and `provider.host` **before** calling `POST /api/translation/translate`.
- Accepting calls `PUT /api/translation/preferences` with `{ consent: true, providerFingerprint }`, recording `consented_provider_fingerprint` and `consented_at`.
- **Server-side gate:** `POST /api/translation/translate` verifies both `status.preferences.consented === true` and `body.providerFingerprint === active.fingerprint`. Requests without matching consent fail with `403 translation_consent_required` before reading the message or contacting the provider.
- **Automatic re-consent on provider change:** If an administrator changes the provider `protocol` or `baseUrl` host, `active.fingerprint` changes. Existing user consent rows no longer match, `consented` evaluates to `false`, the instance cache is cleared, and users are shown the disclosure for the new provider before any text is sent to it.
- **Withdrawal:** Users can revoke consent or clear their cached translations at any time in **User Settings → Privacy**. Withdrawing consent immediately deletes that user's cached translations on the instance.

---

## 3. Outbound Data Minimization & Untrusted Output Handling

When an authorized user translates a message (`POST /api/translation/translate`):

1. **Permission check on authoritative row:** The server resolves the message directly from `messages` (`VIEW_CHANNEL` + `READ_MESSAGE_HISTORY` + `userWrittenMessages()`) or `dm_messages` (`dm_members` membership + user message type). The client does **not** submit arbitrary text to translate.
2. **Token masking (`textPolicy.ts`):** Before building the outbound payload, fenced code blocks, inline code spans, `http(s)` URLs, email addresses, Backspace mention tokens (`<@id>`, `<@&roleId>`, `<#channelId>`), and sticker tokens are replaced with per-call random placeholders (`__BS_<16-hex-nonce>_<index>__`). The model must return every placeholder verbatim and exactly once, otherwise the response is rejected (`502 translation_protected_content`).
3. **Minimum outbound JSON:** Only `{ "targetLanguage": "<BCP-47>", "untrustedText": "<masked string or line array>" }` is sent alongside the static system prompt. Author IDs, usernames, channel names, space names, message IDs, timestamps, and surrounding chat history are never included. For OpenAI Responses, `store: false` is set explicitly.
4. **Plain-text rendering:** `TranslationText.tsx` renders translated strings strictly as plain React text nodes (`whitespace-pre-wrap`), never passing model output through Markdown, HTML, linkification, or image/embed unfurling.

---

## 4. Instance & Account Isolation

- **Account boundary:**
  - Server cache keys (`result_key`) are keyed by `SHA-256(["v1", instanceId, userId, protocol, baseUrl, model, promptVersion, targetLanguage, sourceText])` with primary key `(user_id, result_key)` and AES-256-GCM AAD `v1|cache|<instanceId>|<userId>|<resultKey>`. One user's translation request never hits or decrypts another user's cache entry.
  - Per-user server cache is bounded to `TRANSLATION_CACHE_LIMIT` (500 rows) and `TRANSLATION_CACHE_MAX_BYTES` (8 MiB) via LRU eviction on `accessed_at`.
  - Soft-deleting (`users.is_deleted = 1` in `tombstoneUser`) or hard-deleting a user purges both `ai_translation_preferences` and `ai_translation_cache` via `ON DELETE CASCADE` and the `purge_deleted_user_translation` SQLite trigger.
  - On the client, `translationStore.ts` subscribes to `useAuthStore` and immediately wipes all in-memory statuses, translated entries, and pending consent prompts on logout or account switch.
- **Instance boundary (Federation):**
  - Each `Message` resolves `messageOrigin = channelOriginMap.get(channelKey) ?? ''` and routes `status`, `updatePreferences`, and `translateMessage` through `getApiForOrigin(messageOrigin)`.
  - Translating a message in a space hosted on `https://peer.example` uses `peer.example`'s configured provider (if enabled) under the user's federated account and explicit consent on `peer.example`. Consent granted on the user's home instance never authorizes transfers on a remote instance, and vice versa.

---

## 5. Supported Provider Protocols & Why Anonymous Web Adapters Are Excluded

Supported administrator protocols (`TRANSLATION_PROTOCOLS`):
- `openai-chat` (`POST <baseUrl>/chat/completions`, `GET <baseUrl>/models`)
- `openai-responses` (`POST <baseUrl>/responses` with `store: false`, `GET <baseUrl>/models`)
- `anthropic` (`POST <baseUrl>/messages`, `GET <baseUrl>/models`)
- `gemini` (`POST <baseUrl>/models/<model>:generateContent`, `GET <baseUrl>/models`)

All provider URLs must use `https:` on a public hostname; `providerFetch.ts` resolves DNS A/AAAA records prior to connection, rejects loopback/private/link-local/CGNAT/metadata IP ranges, disables HTTP redirects (`redirect: 'error'`), and omits cookies/credentials.

### Empirical Verification of Experimental Anonymous Web Translators

Earlier prototypes explored zero-key public web translation endpoints (`translate.googleapis.com/translate_a/single` and `www.bing.com/ttranslatev3` + `translator` bootstrap). Live verification in October 2026 confirmed neither is viable as a supported server-side or client-side integration:

- **Google public web endpoint (`translate.googleapis.com`):** Returned `HTTP 429 Too Many Requests` under automated/server-originated traffic without an official authenticated billing key, causing immediate non-deterministic failures for all users sharing an instance IP.
- **Microsoft/Bing public web endpoint (`bing.com/translator` → `ttranslatev3`):** Returned `HTTP 401 Unauthorized` even immediately after fetching a fresh HTML bootstrap page, `IG` correlation token, cookies, and `params_AbusePreventionHelper` token, due to anti-bot session gating.

Because undocumented anonymous web endpoints violate reliability guarantees, Terms of Service expectations, and predictable rate-limit behavior for self-hosted instances, Backspace supports only authenticated HTTPS APIs configured explicitly by the instance administrator.
