# Completion timeout for hanging processes

## Context

`run()` invokes an **agent** through `invokeAgent` in `src/Orchestrator.ts`. The
**completion signal** (`<promise>COMPLETE</promise>` by default) is checked
once, **after** `invokeAgent` resolves (`Orchestrator.ts:426`). `invokeAgent`
resolves only when the underlying `sandbox.exec` resolves, and `exec` resolves
only when the **agent**'s child process closes and its stdout reaches EOF
(`src/sandboxes/docker.ts:295` — `proc.on("close")`). While that hasn't
happened, the only competing outcome in `invokeAgent`'s race is the idle
timer, which fails the run with `AgentIdleTimeoutError` after
`idleTimeoutSeconds`.

In the reported repro (#590, parallel-planner-with-review merger phase), the
agent emits the **completion signal** as its final visible output, but a child
it spawned — a `gh`/git subprocess inheriting the exec's stdout pipe — stays
alive long enough to hold stdout open. EOF never arrives, the success path
never runs, and the run dies at the 10-minute idle timeout. The signal's _line
position_ is incidental: `agentOutput.includes(sig)` would have matched the
moment the signal arrived if anyone had looked. The trigger is **non-exit**, not
position. We call this state a **hanging process**.

## Decision

`invokeAgent` gains a **completion timeout** racing alongside the existing idle
timeout and abort:

- Thread `completionSignal`s into `invokeAgent` and accumulate the parsed
  `text`/`result` output as it streams in. After each `onLine`, check the
  accumulated text against the configured signals.
- **Before** a signal is seen, behavior is unchanged: the full
  `idleTimeoutSeconds` applies, and silence beyond it fails the run with
  `AgentIdleTimeoutError` (a genuinely stuck agent must still fail).
- **Once** a signal is seen, swap the idle timer down to a **completion
  timeout** (default 60s). The timer is reset on every subsequent line, so
  trailing data — Codex's `turn.completed` usage, Claude Code's terminal
  `result`, or a structured-output `<tag>` emitted after the marker — is still
  captured.
- When the completion timeout expires, the race resolves **successfully** with
  the accumulated text. A warning ("completion signal seen but process hasn't
  exited") is logged. The normal success path runs: session capture, commit
  collection, and the existing `Orchestrator.ts:426` check populates
  `completionSignal` from the accumulated text.
- A clean process exit at any point still wins the race, so healthy runs are
  unchanged and gain **zero added latency**. A hanging run turns a 600s failure
  into a ≤60s success-with-warning, and `result.commits` is populated.

The completion timeout is a first-class public option,
`completionTimeoutSeconds`, mirroring `idleTimeoutSeconds`. Default is **60**.
It is independent of `idleTimeoutSeconds` — they are different phases (idle =
no signal yet → fail; completion = signal seen → grace → succeed), each with
its own default — and is not clamped against `idleTimeoutSeconds`.

## Considered Options

1. **Short-circuit on a terminal stream event** instead of the signal string —
   rejected. No reliable cross-provider terminal event exists. Claude Code
   emits one terminal `result` event, but Sandcastle synthesizes a `result`
   event per agent message for Codex (`AgentProvider.ts:551`) and OpenCode
   (`715`), so keying on it would terminate those providers after their first
   message.
2. **Kill the process immediately on signal detection** — rejected. Would
   truncate trailing data (per-turn usage events, terminal results,
   structured-output tags). The silence-based grace window captures it first.
3. **Make the completion timeout a constant** — rejected per the addendum on
   #590. Different workloads want different grace windows; a public option
   lets callers tune it without forking.

## Consequences

- Healthy, fast-exit runs are unaffected — there is no added latency on the
  happy path.
- A hanging-process run turns from a 600s `AgentIdleTimeoutError` failure into
  a ≤60s success-with-warning, restoring `result.commits` and the
  `completionSignal` in `RunResult`.
- The completion timeout is gated strictly on a seen signal. A process that
  hangs _before_ any signal is emitted is indistinguishable from an agent
  stuck mid-work, so it still rides the full idle timeout and fails. That
  asymmetry is deliberate.
- Force-completing abandons the **hanging process**. Docker teardown
  (`docker rm -f`) reaps it, but the **no-sandbox provider** has no process
  kill, so it leaks on the host. Tracked separately in #766.
