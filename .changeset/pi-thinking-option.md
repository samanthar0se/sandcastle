---
"@ai-hero/sandcastle": patch
---

Add a `thinking` option to the `pi()` agent provider. Pass `pi("model", { thinking: "high" })` to forward `--thinking <level>` to the pi CLI. Accepted levels: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`.
