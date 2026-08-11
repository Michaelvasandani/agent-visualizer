# `$code-review` live acceptance

This procedure proves the Agent Tracer against its supported real topology:
one `codex-cli 0.145.0` App Server shared by an interactive TUI and a passive
Tracer. Run it from a clean clone on macOS with Node.js 22 or newer.

## Sensitive-data boundary

The Live Trace, optional Saved Trace, and Evaluation Runs are unredacted. They
can expose prompts, credentials, paths, proprietary content, personal data,
command output, and diffs. Evaluation Runs send the full Skill Contract and
Trace to OpenAI through the developer's existing Codex authentication. Use a
repository and export location suitable for that disclosure.

No file is persisted unless `--export` is provided. The export command refuses
to overwrite an existing path.

## Reproduce the acceptance run

Confirm the exact supported versions and install dependencies:

```sh
codex --version
node --version
npm install
npm run typecheck
npm test
```

`codex --version` must print `codex-cli 0.145.0`. Start the shared server in
terminal 1:

```sh
npm start -- server --listen ws://127.0.0.1:4500
```

Start the interactive client in terminal 2 and decline any offered upgrade:

```sh
codex --remote ws://127.0.0.1:4500 --no-alt-screen -C "$PWD"
```

Begin a non-empty review turn from the TUI, using the commit before the changes
under acceptance as the fixed point:

```text
$code-review Review the changes since <fixed-point>.
```

Immediately after the TUI shows the turn as working, attach from terminal 3:

```sh
npm start -- trace \
  --server ws://127.0.0.1:4500 \
  --export /tmp/agent-tracer-code-review.json
```

If the TUI is the only client thread, the Tracer selects it automatically. If
several threads are loaded, choose its number explicitly. Codex 0.145.0 may
replay the `$code-review` invocation as text without structured skill metadata;
when the Tracer presents that history-derived candidate, confirm it only after
checking the displayed skill name and path.

Wait for the TUI turn and both post-run Evaluation Runs to finish. The Tracer
must exit zero and the terminal must show the observed terminal outcome, Trace
integrity, Root Skill Attribution, Skill Contract, Obligations, Findings, and
the Saved Trace path.

Inspect the saved evidence without copying it to another location:

```sh
jq '{schemaVersion, protocolCompatibility, run, terminalOutcome, traceIntegrity,
     skillAttribution, eventKinds: [.events[].kind] | unique,
     obligationCount: (.obligations | length),
     findingCount: (.findings | length)}' \
  /tmp/agent-tracer-code-review.json
```

Evaluation Runs are excluded when every saved Event belongs to the observed
thread or one of its causally reported descendants. The deterministic
black-box acceptance test additionally assigns recognizable Evaluation Run
thread ids and asserts that none occur in the Saved Trace. It also verifies the
Tracer sends no `turn/start`, `turn/steer`, or `turn/interrupt` request to the
observed thread.

## Codex 0.145.0 limitations

- The App Server WebSocket transport is experimental and only 0.145.0 is
  accepted. A different CLI or server version is rejected before observation.
- A newly opened, idle TUI can appear in `thread/loaded/list` before it has a
  resumable rollout. Attaching then returns `no rollout found`; start the turn
  and attach again.
- Mid-turn resume can return `itemsView: notLoaded`. The Tracer truthfully marks
  the resulting notification-only interval as an Incomplete Trace even when
  subsequent live activity is observed.
- Resumed TUI history may preserve `$code-review` only as prompt text, requiring
  developer confirmation instead of exact attribution.
- Only File Changes explicitly emitted by Codex are shown. A command does not
  imply a File Change, and a read-only review may emit no File Change category.
- Event categories are reported only when Codex emits them. Do not infer or add
  missing subagent, tool, File Change, token, or duration Events to make an
  acceptance transcript appear more complete.
- The Tracer must remain attached until the observed turn terminates. A closed
  connection triggers history recovery, but notification-only gaps can remain
  unobservable.

The deterministic fixture inventory and capture provenance are documented in
`test/fixtures/codex-0.145.0/README.md`.

## Recorded acceptance

The repository records the exact live result here after the fixture and
documentation changes have a non-empty commit range for `$code-review` to
review. The initial topology probe on 2026-08-11 verified the shared server,
interactive TUI, passive command/resource/token/duration observation, and the
history confirmation prompt. It intentionally does not count as final
acceptance because its fixed point equaled `HEAD`, so `$code-review` correctly
stopped before spawning its two reviewers.
