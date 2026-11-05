# Gemini grounded AI suggestions

Gemini powers the existing M9 grounded-suggestions workflow only. It does not enable the older per-incident AI analysis provider. The adapter uses the fixed Google Gemini `generateContent` REST endpoint with JSON-schema output; no SDK or new dependency is required.

## Local configuration

Set these values in `apps/api/.env` (never in web env files or committed files):

```dotenv
AI_ENABLED=true
AI_PROVIDER=gemini
GEMINI_API_KEY=your-local-key
# Optional; defaults to gemini-3.5-flash-lite
# AI_MODEL=gemini-3.5-flash-lite
AI_DAILY_REQUEST_LIMIT=20
```

Restart the API. Sign in as an organization owner/admin, enable **AI suggestions** on the Team page, create a synthetic incident, and request a suggestion from its detail page. The organization opt-in is separate from the server-wide `AI_ENABLED` and provider/key settings.

## Safety and data use

The application sends only its bounded suggestion context after best-effort redaction of common credentials and personal-data patterns. Redaction is not a guarantee. The Gemini API Free tier may use submitted prompts and generated responses to improve Google products, including human review. Do not use a Free-tier key with confidential, personal, customer, or production incident data. The live acceptance test must use synthetic incident content.

Provider output is never trusted directly: the existing job handler validates its shape, source aliases and exact supporting quotes before a suggestion can be stored. Applying a suggestion only pre-fills the normal human-reviewed severity/comment forms; it does not change incident state or post a comment by itself. The default per-organization quota is 20 requests per UTC day.

## Deployment

Keep AI disabled until the owner has configured the API key. In Render's API service environment, set `AI_PROVIDER=gemini`, `AI_ENABLED=true`, and `GEMINI_API_KEY` using the secret value from Google AI Studio. `AI_MODEL` is optional; the API defaults to `gemini-3.5-flash-lite`. Then deploy/restart the API, enable AI suggestions for the test organization, and perform one synthetic incident test. Never put the key in GitHub, the frontend, screenshots, logs, or chat.
