# Northstar Logs & Audit

The Logs & Audit center uses one event model, but separates meaning by tab.

## Severity

- `debug`: diagnostic detail intended for troubleshooting.
- `info`: normal operation or a completed action.
- `warning`: a condition that needs review; it does not by itself mean data loss or compromise.
- `error`: an operation failed and may affect reliability or data freshness.
- `critical`: a high-impact condition that should be investigated before continuing.

## Provider semantics

`Codex / Claude Usage` events describe locally imported usage and observed quota windows for hosted coding assistants. They are capacity alerts, not local-model safety alerts.

`Local LLM` events describe local Ollama-style inference: connectivity, latency, malformed output, and Planner policy boundaries. Local models do not use the Codex/Claude subscription-quota rules.

## Quota rules

- `USAGE-QUOTA-80`: observed quota is at least 80%. Check the reset time and avoid non-essential long sessions.
- `USAGE-QUOTA-95`: observed quota is at least 95%. Save work and expect throttling or unavailability until reset.

The values come from local usage logs. If a provider does not expose a limit snapshot, Northstar does not invent a quota alert.

## Handling an event

Read the source, event type, details, and explanation first. Resolve only after the underlying condition is understood; keep security or critical events open until investigated.
