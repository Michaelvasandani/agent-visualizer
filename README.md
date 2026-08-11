# Agent Tracer

Agent Tracer is a source-run macOS CLI for passively observing a live Codex
Skill Run through a shared Codex App Server. The current first slice supports
exactly `codex-cli 0.145.0` and automatically attaches when the server has one
loaded thread.

## Requirements

- macOS
- Node.js 22 or newer
- Exactly `codex-cli 0.145.0` available as `codex` on `PATH`

Install the development dependencies with:

```sh
npm install
```

## Run a live Trace

Start the shared App Server in one terminal. This foreground process owns the
server and prints the command needed by the interactive client:

```sh
npm start -- server --listen ws://127.0.0.1:4500
```

Connect the interactive Codex TUI in a second terminal:

```sh
codex --remote ws://127.0.0.1:4500
```

Attach the Tracer from a third terminal:

```sh
npm start -- trace --server ws://127.0.0.1:4500
```

The Tracer initializes and lists loaded threads. It selects a sole loaded thread
automatically; when several are loaded, it displays every thread ID and waits
for an explicit numbered selection. It never guesses from recency.

After the selected thread is resumed as a passive subscriber, the Tracer
reconstructs available history before rendering buffered and subsequent live
activity. Historical and live observations pass through the same Event pipeline,
which suppresses duplicate lifecycle Events and prints stable Event identity,
per-thread sequence, and causal turn metadata. The Tracer does not start, steer,
interrupt, or otherwise control the observed Skill Run, and unsubscribing does
not affect the run.

The Live Trace is deliberately unredacted. Prompts, credentials, paths,
proprietary content, personal data, and future evaluation inputs may appear in
terminal output. Future Evaluation Runs will send the unredacted Skill Contract
and Trace to OpenAI. This slice does not persist Trace data.

## Development

```sh
npm run typecheck
npm test
npm run build
```
