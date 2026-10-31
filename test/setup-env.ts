// Test-only placeholders keep strict environment modules deterministic without
// reading a developer's .env or granting access to any external service.
process.env.SKIP_ENV_VALIDATION ??= "1";
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:5432/appstore_test";
process.env.BETTER_AUTH_SECRET ??= "test-only-secret-test-only-secret-123";
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:3000";
process.env.CORS_ORIGIN ??= "http://127.0.0.1:3001";
process.env.VITE_SERVER_URL ??= "http://127.0.0.1:3000";
process.env.VITE_WEB_URL ??= "http://127.0.0.1:3001";
process.env.VITE_ENABLE_INDEXING ??= "false";
process.env.COPILOT_MODEL_PROVIDER ??= "openai-compatible";
process.env.COPILOTKIT_TELEMETRY_DISABLED ??= "true";
