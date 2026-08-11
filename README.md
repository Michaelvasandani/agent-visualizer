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

When the live user input includes Codex's structured skill name and path, the
Tracer records exact Root Skill Attribution without prompting. If replayed
history contains only a `$skill-name` mention, the Tracer resolves it against
the skills available in the thread working directory and requires developer
confirmation. Missing, ambiguous, or rejected historical candidates leave
attribution unresolved and explicitly block later Conformance evaluation while
preserving the completed Trace.

For an attributed Root Skill, the Tracer constructs an execution-only Skill
Contract from its `SKILL.md` and recursively linked Markdown instruction files.
It reads those files as text without running referenced code, follows each file
once with cycle deduplication, and retains behavioral instruction blocks
while excluding contextual prose and final-result quality from the contract.

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
