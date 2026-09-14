# shapeshyft_service

> **Git policy — never auto-commit or auto-push.** Run `git commit`, `git push`,
> or publish only when the user explicitly asks in that turn.

Shared backend for `shapeshyft_api` and `shaperouter_api`: Drizzle table
factories, idempotent DDL, Hono routers, auth and rate-limit middleware.
Stateless LLM work (adapters, prompts, media, provider catalog) lives in
`@sudobility/shapeshyft_engine`.

## The seam

The service never knows where a provider API key lives. The app passes a
`ProviderCredentialResolver`:

- `bindEndpoint` — endpoint create/update; returns the `provider` and
  `llmKeyId` to persist, or a `{ status, message }` failure.
- `resolve` — invoke and prompt-preview time; returns `provider`, `apiKey`,
  `endpointUrl`, `timeoutMs`, or a failure.

Optional `InvokeHooks`: `beforeInvoke` (after rate limiting; return a Response to
stop) and `afterInvoke` (inside the usage_analytics transaction).

## Client IP

`getPeerAddress` (required) supplies the TCP peer, which the service cannot read
without a runtime adapter; apps pass `getConnInfo` from `hono/bun`. The endpoint
IP allowlist uses `resolveAllowlistIp` (`lib/client-ip.ts`): a public peer is the
caller and its headers are ignored; forwarded headers are read only from a
private peer (our proxy), preferring `CF-Connecting-IP`, then `X-Forwarded-For`
right to left. Unknown peer means deny. Trusting `CF-Connecting-IP` assumes the
origin accepts traffic only through Cloudflare and the internal proxy.

## Rules

- No `process.env`. Add a field to `ShapeshyftServiceConfig` instead.
- No reference to `llm_api_keys`. The binding column is `llm_key_id`, nullable,
  no FK here; apps add their own FK.
- Relative imports carry `.js`.
- Handler error messages and status codes are part of two products' public APIs.

## Tests

    bun run test      # unit, no DB
    TEST_DATABASE_URL=postgresql://localhost:5432/shapeshyft_test bun run test:db
