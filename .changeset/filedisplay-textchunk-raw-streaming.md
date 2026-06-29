---
"@ai-hero/sandcastle": patch
---

Fix file-mode logging so streamed agent text flows as contiguous prose instead of one chunk per line. Added a dedicated `textChunk` streaming method to the display service (raw, no implied newline in file mode) and pointed the text-delta buffer at it, leaving the line-oriented `text()` for discrete entries like context-window summaries. Structured entries (tool calls, status, summaries) still always begin on their own line, even when they immediately follow a mid-line streamed chunk.
