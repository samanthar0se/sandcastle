---
"@ai-hero/sandcastle": patch
---

Fix `RangeError: Invalid string length` crash on long agent runs. When streaming `exec` output via `onLine`, sandbox providers accumulated every line and joined them into one string at completion; past V8's ~512MB max string length this threw inside a `close` event handler — an uncaught exception that bypassed `Promise.allSettled` and took down the whole run, including parallel pipelines. Streamed stdout and stderr are now kept in a bounded rolling tail (default 64KiB, configurable per provider via `maxOutputTailChars`). Live output to `onLine` is unaffected.
