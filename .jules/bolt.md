## 2025-03-09 - Avoid instantiating Date objects for timestamps
**Learning:** For performance-critical code or high-frequency inner loops, avoid object and string allocations. Instantiating a Date object (e.g., `new Date(string).getTime()`) introduces unnecessary memory allocation and garbage collection pressure if you only need the underlying timestamp.
**Action:** Use primitive math like `Date.parse(string)` instead of `new Date(string).getTime()` when parsing ISO 8601 strings into timestamps to minimize garbage collection pressure.## 2024-11-20 - Use Date.parse instead of new Date().getTime()
**Learning:** Using `new Date(string).getTime()` creates intermediate Date objects, increasing GC pressure, whereas `Date.parse(string)` avoids object allocation entirely.
**Action:** When converting ISO 8601 date strings to timestamps, use `Date.parse(string)` to improve performance and minimize garbage collection.
