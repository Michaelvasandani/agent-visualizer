# Agent Tracer

Agent Tracer is a source-run macOS CLI for passively observing a live Codex
Skill Run through a shared Codex App Server. It includes a loopback-only Trace
Explorer service and the original terminal projection. The current slice
supports exactly `codex-cli 0.145.0` and automatically attaches when the server
has one loaded thread.

## Requirements

- macOS
- Node.js 22 or newer
- Exactly `codex-cli 0.145.0` available as `codex` on `PATH`

Install the development dependencies with:

```sh
npm install
```

## Launch the Trace Explorer

Start the loopback-only Trace Explorer and an owned shared Codex App Server from
one foreground command:

```sh
npm start -- web
```

The command prints the local browser URL and the `codex --remote` command for an
interactive TUI, then opens the browser. Pass `--no-open` to leave browser
launching to the developer. To attach to an App Server managed by another
process, pass its URL; Agent Tracer will unsubscribe and close its own resources
without stopping that server:

```sh
npm start -- web --server ws://127.0.0.1:4500 --no-open
```

Browser refreshes and disconnects do not stop collection. Each browser socket
receives the complete in-memory update snapshot on connection and structured
incremental updates afterward. During active observation, the first interrupt
defers shutdown until observation and already-started Conformance work settle;
a second interrupt forces shutdown and may interrupt an owned Codex App Server.

## Run a live Trace in the terminal

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

Trace data remains in memory unless export is explicitly requested. To write a
self-contained Saved Trace after Conformance evaluation finishes, provide one
output path:

```sh
npm start -- trace --server ws://127.0.0.1:4500 --export ./audit.json
```

The CLI repeats the unredacted-sensitive-data warning immediately before it
writes the versioned JSON bundle. Existing files are not overwritten.

Replay a Saved Trace offline through the same terminal Event projection used by
live observation:

```sh
npm start -- replay --file ./audit.json
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

Completed, failed, and cancelled Skill Runs have separate terminal outcome
lines; Trace integrity is reported independently. Non-empty replayed history is
marked incomplete because notification-only activity from before attachment
cannot be reconstructed. After a connection interruption, the Tracer reconnects
and replays available item history through the same deduplicating pipeline, but
retains an Incomplete Trace interval for notification-only or descendant-source
activity that history cannot recover. Failed recovery reports the affected
interval, sources, and error before the CLI exits.

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
Relative references resolve from the referring file first, then from the
observed working directory when an externally installed skill names a
repository-relative instruction file.

The Live Trace and Saved Trace are deliberately unredacted. Prompts,
credentials, paths, proprietary content, personal data, and evaluation inputs
may appear in terminal output or an explicitly exported JSON bundle. Evaluation
Runs send the unredacted Skill Contract and Trace to OpenAI. Without `--export`,
the Tracer does not persist Trace data.

For the reproducible real `$code-review` acceptance procedure, protocol capture
inventory, and known Codex 0.145.0 App Server limitations, see
[`docs/code-review-acceptance.md`](docs/code-review-acceptance.md).

## Development

```sh
npm run typecheck
npm test
npm run build
```
