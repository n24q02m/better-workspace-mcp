## 2024-06-25 - Add dark mode support and semantic landmarks to OAuth callback
**Learning:** Even simple inline HTML pages (like OAuth callbacks) need semantic landmarks (`<main>`) for screen readers and `color-scheme: light dark` meta tags to prevent blinding white flashes for users with dark system themes.
**Action:** Always include semantic HTML tags (`<main>`) and support basic accessibility/UX needs (like dark mode meta tags) even in minimal inline HTML responses.
