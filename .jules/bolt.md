## 2025-02-28 - Avoid array allocations in tight loops
**Learning:** For rendering large strings from arrays (e.g. converting 10,000+ sheet rows to CSV or text), chaining array methods like `row.map(cell => cell || '').join(',')` inside a `forEach` loop causes high object allocation overhead, slowing execution and increasing garbage collection pressure.
**Action:** Replace `Array.prototype.forEach`, `.map()`, and `.join()` in tight loops with primitive nested `for` loops and direct string concatenation. This drastically lowers GC pressure and speeds up execution for large datasets.
