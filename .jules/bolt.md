## 2025-02-18 - Concurrent Network Requests in Fallback
**Learning:** Sequential network calls inside `for...of` loops, such as when doing a sheet-by-sheet fallback during a failed `batchGet`, create a massive N+1 bottleneck where total request latency scales linearly with N items.
**Action:** Replace sequential API fetch loops with `await Promise.all(items.map(async item => { ... }))` to execute I/O concurrently whenever each request's result is independent of the others. Make sure to embed `try/catch` handlers inside the mapped promise so a single failure doesn't halt the entire batch.

## 2026-08-09 - Concurrency limits on Google API calls
**Learning:** Naively parallelizing network requests without a concurrency limit can cause rate limiting (`429 Too Many Requests`). Unbounded `Promise.all` over dozens of resources is a bad pattern.
**Action:** When replacing sequential network fallback loops with concurrent ones, always use a concurrency-limited map (like `p-map` or a custom semaphore) and include truncated-exponential backoff for retries to avoid rate limit failures.
