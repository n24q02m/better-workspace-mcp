## 2026-08-01 - Optimizing sequential API fallback calls
**Learning:** In fallback loops that iterate over an array (e.g., retrieving Google Sheets sequentially after a batch operation fails), sequential `await`s in a `for...of` loop can cause significant latency due to blocking network calls.
**Action:** Replace `for...of` loops with `Promise.all(array.map(async item => { ... }))` to execute network requests concurrently while still isolating individual failures using `try/catch` within the map callback.
