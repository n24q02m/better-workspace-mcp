## 2026-08-09 - Unbounded Promise.all in API fallback
**Learning:** Replacing sequential API calls (e.g., in fallback loops for Google Sheets) directly with `Promise.all` introduces unbounded concurrency. This can cause the application to hit API rate limits (like HTTP 429 Too Many Requests) and fails acceptance criteria when no concurrency limit or truncated-exponential backoff is present.
**Action:** Always implement bounded concurrency (e.g., using `p-limit` or batching) or a rate-limit aware backoff strategy instead of unbounded `Promise.all` for network requests.
