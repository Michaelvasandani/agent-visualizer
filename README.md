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

Once that server has exactly one loaded thread, attach the Tracer from a third
terminal:

```sh
npm start -- trace --server ws://127.0.0.1:4500
```

The Tracer initializes, lists loaded threads, resumes the sole thread as a
passive subscriber, and renders user, tool, and command activity as append-only
terminal Events. It does not start, steer, interrupt, or otherwise control the
observed Skill Run.

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
