# Private AI and Message Translation

## Scope and entry points

Open **User settings → AI & translation** in the Web or Electron client. Add a named connection, choose the global AI connection, and optionally override it with a translation-specific connection. “Global” means the current user’s default connection, not an instance-wide shared credential. Web settings belong to the authenticated home-server account; desktop settings stay local to the current device, home instance and account.

Each connection has a protocol, API root URL, model and optional API key. Up to 20 connections are supported. For an endpoint that does not require authentication, explicitly select the no-key option. Saving an existing connection with an empty password field preserves its saved key; changing its URL or protocol requires re-entering or explicitly clearing that key. Saved keys are never returned to the page.

The URL is the protocol root, **not** the final request endpoint:

| Protocol | Example root | Appended endpoint |
| --- | --- | --- |
| OpenAI Chat Completions / compatible | https://api.openai.com/v1 | /chat/completions |
| OpenAI Responses / compatible | https://api.openai.com/v1 | /responses |
| Anthropic Messages | https://api.anthropic.com/v1 | /messages |
| Google Gemini | https://generativelanguage.googleapis.com/v1beta | /models/{model}:generateContent |

Use **Fetch models** in the connection editor or enter a model ID supported by the chosen provider. Discovery does not rewrite incompatible protocols or guarantee access to a listed model. Web/server provider endpoints must be public HTTPS addresses. Desktop direct requests additionally allow HTTP for localhost, 127.0.0.1 and [::1]. URL credentials, query parameters and fragments are rejected, and redirects are not followed.

Choose a message preference language and explicitly consent to sending eligible text to the selected provider. Automatic translation is off by default; the initial target is English, independently of the interface language. The **Test connection** button sends a fixed sample using the **current editor values**, without saving them, using translation caches or reading message history. It can reuse the saved key only for the same account, endpoint and protocol.

- **Manual:** use a text message's context menu → Translate message.
- **Automatic:** enable automatic translation to process eligible visible messages while the document is in the foreground. This does not scan all channels or unloaded history.
- **Show original on:** keep the original body and display the translation below it (WeChat-style).
- **Show original off:** render the translation in place of the message body (Telegram-style), with a local action to view the original. This changes presentation only; editing, server storage and other users still receive the original message.

Supported targets: Simplified Chinese, Traditional Chinese, English, Japanese, Korean, German, French, Spanish, Portuguese, Russian and Arabic. Clients without a native translation bridge use the authenticated home-server HTTP API. They never use a browser plaintext key store. Native bridge failures do not switch to the server, and existing desktop settings are not uploaded automatically.

## Web/server deployment and security boundary

The Web client previously required desktop IPC because that was the only implementation with encrypted credential storage and a non-CORS provider transport. Web now has its own authenticated server path; it does not weaken desktop secure storage or silently upload existing desktop credentials.

New installations need no manual key configuration. On first startup the server generates **32 cryptographically random bytes** and writes `ai-translation.key` next to `DB_PATH` (Docker default: `/app/data/ai-translation.key`, persisted by the existing `./data:/app/data` volume). It uses mode 0600 and atomic no-overwrite publication so concurrent starts reuse the same complete key. This is standard AES-256-GCM, not a date/hardware-derived key or a custom cipher.

`AI_TRANSLATION_ENCRYPTION_KEY` remains an optional, higher-priority override (64 hexadecimal characters; generate with `openssl rand -hex 32`). Existing installations using this override must retain it: removing it does not migrate existing encrypted records to a new key. No key is placed in the image, browser build, source control, logs or API responses. In-memory databases require an explicit key because they have no durable data directory.

Back up the key securely and separately from database-only backups. Restore the matching key and database together. The automatic file shares the data volume, so anyone with the entire volume can decrypt the database; administrators already have runtime access. Startup fails explicitly on missing keys for existing encrypted data, malformed/mismatched keys, corrupt encrypted samples, or storage failures. There is no plaintext fallback, silent regeneration or data reset. Changing the key alone is not key rotation. Multi-process deployments must share the same data volume/key (or identical explicit override).

1. Web sends commands to POST /api/translation/command on the home instance, not the currently viewed federated space. Requests require the existing authenticated Bearer session. HTTP is allowed only for loopback development origins; deployed Web must use HTTPS.
2. The server derives ownership from the verified login and rejects mismatched account IDs and federated shadow accounts. It reads only that account’s settings. Settings and cached translations are not exposed via federation or other users’ APIs; the same account on another Web device can reuse its server-side configuration, but never read back the saved API key.
3. Settings are encrypted as a whole using AES-256-GCM with a fresh 12-byte nonce and a 16-byte authentication tag. Authenticated context binds ciphertext to the account and settings/cache purpose (and cache key), preventing row swaps. Provider keys are decrypted only in server process memory for outbound authentication.
4. Consent, settings revision and language eligibility are checked before contacting the selected provider. Eligible text goes to that provider; the API key appears only in its authentication header, never the prompt. Result-cache hits do not contact the provider.
5. Outbound HTTPS uses DNS validation in the socket lookup itself, rejecting any non-public result and returning exactly those verified addresses to the socket. Localhost/private networks, cloud metadata addresses, unsafe IP encodings and redirects are blocked. TLS certificate/hostname verification remains enabled. No environment proxy or ambient cookies are used.
6. API responses expose safe error codes, never provider error bodies or saved credentials. Application logs contain no translation body/key. Operators must also avoid request-body capture in reverse proxies, tracing and external logging systems. API responses use Cache-Control: no-store. The route uses the existing rate limiter (90 commands/minute/IP) and a 48 KiB request-body limit.
7. Soft/hard account deletion removes server translation settings and results. In-flight requests check the account again before writing, so deletion cannot resurrect this data.

**This is encryption at rest, not end-to-end encryption.** The server must see credentials and source text during translation, and the server operator can access both the encryption key and process memory. Only use a server you trust. Browser JavaScript sees a newly typed key; XSS on the trusted origin is outside the protection of database encryption. The browser does not persist API keys to localStorage, sessionStorage or IndexedDB.

## Desktop data flow and security boundary

1. The renderer requests an operation through the narrow preload translation bridge.
2. Native IPC accepts only the configured instance origin, the main window and its main frame. Inputs are validated again in the native process.
3. The native process reads the origin/account-scoped encrypted configuration, verifies consent and revision, and performs local language filtering.
4. Only eligible text is sent directly to the selected provider. The key is used in the protocol authentication header, never the translation prompt or a Backspace API request.
5. The native process checks its local encrypted result cache before contacting the provider. On a miss, it validates and restores protected tokens, then caches the successful translation. The renderer renders the result as plain text.

The entire configuration is encrypted using Electron safeStorage and stored under the desktop userData directory in local-ai/<SHA-256(origin + newline + accountId)>.bin. New directories/files use 0700/0600 permissions. OS encryption must be available for persistence; Linux basic_text is rejected instead of silently storing recoverable plaintext. There is no Backspace synchronization, sharing, key readback API, or localStorage persistence. OS-level device backups remain outside this feature's control.

**The configured instance renderer is still a trust boundary.** The existing desktop architecture loads that instance's web client. Its JavaScript can see a key while the user types it into the settings form, and can invoke exposed native translation operations. Origin/frame checks do not protect against malicious code or XSS in that trusted main-frame origin; account scoping is not an authentication boundary against such code. Use only a trusted instance client. Native encrypted storage does not make an untrusted web client safe.

Direct third-party calls necessarily disclose the eligible message text to that provider; API calls may cost money and provider retention policies apply. “Keys stay local” means no Backspace upload/synchronization: remote provider authentication still transmits the key to the explicitly configured recipient over HTTPS. The implementation does not provide offline translation or promise third-party zero retention. Responses requests set store:false, which is not a general retention guarantee.

## Eligibility and prompt policy

Only user-authored message body text is integrated. System events, attachment contents, OCR, audio, transcription, stickers and unsent/editing rows are not submitted. The shared engine (native process or server) skips pure links, emojis, recognized standalone code and text already detected as the target language. Fenced/inline code, URLs, email addresses and chat tokens are replaced with per-request random placeholders before transmission; placeholders must return exactly once and are restored by the same engine.

Language detection uses tinyld in the translation backend, without a third-party detection call, with a conservative score/margin rule. Short ambiguous Latin fragments and low-confidence detections are skipped for both manual and automatic requests. This is a statistical classifier, not a guarantee for every short, mixed-language or unusual message. Simplified and Traditional Chinese are treated as the same source language, so this feature is not a script-conversion tool.

The immutable, English, versioned policy shared by desktop and server lives in packages/translation/src/prompt.ts. It instructs the model to translate user-authored chat text while preserving meaning and tone, not answer it. Source text is a separate JSON payload labelled untrustedText. Instructions, role labels and requests inside that text remain translation data.

Prompt wording alone is not an absolute prompt-injection defense. Hard boundaries also apply:

- No tools, browsing, execution, conversation history or credentials in the prompt.
- Exact translation-only JSON output; incomplete responses and tool calls are rejected.
- Protected-token integrity checks and response-size limits.
- Translations are React text, not interpreted HTML/Markdown, clickable model-generated links, images or mentions.
- No automatic fallback provider, automatic retry or silent success on failure. The original remains available on every error.

## Scheduling, lifetime and errors

The renderer uses one serial queue and gives manual requests priority. Automatic translation and edit refresh wait 400 ms for the visible text to settle; scrolling away, editing again, unmounting or hiding the window cancels unsent work. Already transmitted text cannot be retracted. A background failure pauses both automatic translation and edit refresh and exposes an error; resuming or retrying is an explicit user action. There is no failure caching or automatic retry.

A manual translation choice or completed translation tracks that message identity in the current account session (up to 1000 identities). Its subsequent body edits refresh when visible, even with global automatic translation disabled. Never-translated messages remain untouched with automatic translation off. Old-body replies cannot replace current-body text. Metadata-only updates do not trigger translation. Unmount/remount retains this intent within the session; logout/restart clears it. Editing to the preferred language or non-text is skipped by the backend and shows the current original instead.

At most 200 results are retained in renderer memory, keyed by account/session, effective configuration, message identity and exact body. Native results additionally persist in OS-encrypted files under local-ai/results/<scope-hash>/<result-hash>.bin, with 0700/0600 directory/file permissions. Each origin/account retains at most 1000 results and 16 MiB, evicting least-recently-used entries. Only the restored translation is stored as encrypted data; source text is represented by a hash, not a separate plaintext copy. Keys, connection metadata and original message records are not stored in the result cache. No native result cache is uploaded or synchronized. Logout clears renderer data and pending work, but keeps the local encrypted disk cache for later reuse. OS/device backup behavior is outside the feature.

Both backends use the same cache identity, which includes the exact original text (before random placeholders), target language, effective protocol/base URL/model or anonymous engine, prompt version and text-policy version. It excludes message IDs, connection names/IDs, API keys, display choices and revision numbers. Consequently identical messages in the same account/configuration, returning to an earlier body, key rotation, renaming, unrelated connection edits and restarts can reuse a result without an upstream request. Duplicate in-flight requests share one promise. Successful, validated work is retained even if settings revision changes while waiting, but not if consent has been withdrawn; each caller still checks its own revision before receiving a result. Cached reads also require consent and pass backend language eligibility.

Web results persist separately in ai_translation_results: per-account result hashes and AES-GCM encrypted translations, bounded to 1000 entries / 16 MiB of ciphertext. Source text is not duplicated into this cache. Settings use ai_translation_settings. Both tables are created by migration 0027_ai_translation. Logout clears renderer memory, not the encrypted server cache. Server database backups and administrator access apply to these records. No desktop cache is migrated to the server.

A changed body/language/provider/model/policy needs a compatible cached result or a new translation. Eviction requires translating again on demand. Cache corruption, permission or encryption errors are reported explicitly, never treated as a silent cache miss. The compact v3 prompt preserves the untrusted-source and strict-output boundaries. No model-specific reasoning flags or arbitrary output truncation are introduced: actual token savings depend on the provider/model, while a cache hit sends no provider request.

Each provider HTTP request has a 25-second timeout and a 256 KiB response limit (1 MiB for the Bing bootstrap page). The Web-to-server request has a 30-second timeout. There is no chunking: AI source messages are limited to 6000 UTF-16 code units; experimental anonymous requests to 3000 after placeholder preparation. Errors expose safe categories and HTTP status, not provider response bodies, source text, authorization headers or secret-bearing URLs.

## Experimental no-key providers

Google Translate and Microsoft Bing Translate can be explicitly selected as translation engines. They use unofficial public-web endpoints, not the paid Cloud Translation / Azure Translator APIs. They require no user key in this feature, but have no availability guarantee; quotas, access requirements and terms can change. They never receive an AI connection's key.

Bing obtains transient public session parameters from its translation page. These parameters are held only for that call, with no browser-account cookies or persisted session. Neither adapter bypasses authentication checks, CAPTCHAs or rate limits. The app will not silently switch to these providers when an AI request fails.

**Live verification on 2026-10-09 did not produce a successful free-provider translation:** Google returned HTTP 429; Bing returned HTTP 401 even with fresh public session parameters. The adapters remain explicitly experimental, not a verified stable backup service.

## Source map and verification

- packages/shared/src/translation.d.ts: types-only IPC/HTTP command contract.
- packages/translation/src/: shared validation, text policy, English prompt, provider adapters, cache identity and service. Source has its own ESM package marker for server tsx/esm; desktop builds CommonJS output under dist, governed by the root CommonJS package marker.
- packages/desktop/src/translation/: OS-encrypted vault/cache and native IPC adapter.
- packages/server/src/translation/ and src/routes/translation.ts: AES-GCM, authenticated HTTP, encrypted database storage and SSRF-safe provider transport.
- packages/web/src/features/translation/: settings, connection editor, serial queue/cache, message hook and display.
- Message.tsx, messageMenuItems.tsx and settings navigation: integration points.

Automated coverage includes Web settings without a desktop bridge, real JWT/HTTP authentication, encrypted database storage and deletion cleanup, nonce/tamper/account-context checks, DNS/socket destination restrictions, the production tsx/esm import path, four protocol request/response shapes, no-key adapters with mocked responses, local filtering, protected-token integrity, key redaction/encryption boundaries, untrusted IPC rejection, explicit failures without fallback, account-switch races, visible-only scheduling and both display modes. Mocked API success is **not** a real-provider compatibility guarantee.

No real AI credentials were supplied, so paid AI calls have not been live-tested. Electron startup, operating-system keychain behavior and browser visual interaction have not been manually exercised. New translation tests use in-memory databases and mocked provider responses. Always set `DB_PATH=:memory:` (or a disposable database path) when running server tests; do not run tests against deployment data.

## Connection diagnostics and complete multi-line translation

The connection editor can fetch model IDs for OpenAI Chat/Responses (GET /models), Anthropic (GET /models with after_id pagination), and Gemini (GET /models with pageToken pagination; generateContent-capable models only). Listings are bounded to 20 pages / 1,000 unique IDs; repeated cursors, invalid schemas and failures are errors, not partial success. A model ID can still be entered manually when a provider does not expose discovery. A listed model is not proof of account access or translation quality.

Testing always calls the selected protocol/model with a small fixed Chinese-to-English sample. It never reads chat history, uses result caches, changes preferences or enables automatic translation. Both actions use the current unsaved form; a missing key can reuse the saved account-scoped key only when endpoint and protocol match. Changing either requires a new key or explicit keyless mode. All existing authentication, SSRF, response-size, timeout and redacted-error boundaries apply. Tests may incur API charges; no provider fallback or automatic retry occurs.

Prompt v3 asks for idiomatic conversational language without changing meaning, tone or security boundaries. Multi-line AI messages send all nonempty lines together in one request, preserving cross-line context, and require one nonempty output per line in order. Blank lines and separators are restored locally. Missing/merged lines are rejected and not cached rather than replacing the message with just its parenthetical aside. Language detection also checks individual lines so a long preferred-language aside cannot suppress a confidently identified foreign-language line. This is structural validation, not a guarantee of semantic completeness or model quality.
