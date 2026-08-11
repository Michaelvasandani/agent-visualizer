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

If `jq` is unavailable, use Node.js to inspect the same fields; Node.js is
already required by this project:

```sh
node --input-type=module -e '
  import { readFile } from "node:fs/promises";
  const trace = JSON.parse(await readFile(process.argv[1], "utf8"));
  console.log({
    schemaVersion: trace.schemaVersion,
    protocolCompatibility: trace.protocolCompatibility,
    run: trace.run,
    terminalOutcome: trace.terminalOutcome,
    traceIntegrity: trace.traceIntegrity,
    skillAttribution: trace.skillAttribution,
    eventKinds: [...new Set(trace.events.map((event) => event.kind))].sort(),
    obligationCount: trace.obligations.length,
    findingCount: trace.findings.length,
  });
' /tmp/agent-tracer-code-review.json
```

Evaluation Runs are excluded when every saved Event belongs to the observed
thread or one of its causally reported descendants. The deterministic
black-box acceptance test additionally assigns recognizable Evaluation Run
thread ids and asserts that none occur in the Saved Trace. It also verifies the
Tracer sends no `turn/start`, `turn/steer`, or `turn/interrupt` request to the
observed thread. After the root turn terminates, the Tracer passively resumes
causally reported descendant threads, replays their available item history as
child-sourced Events, and unsubscribes from every successfully resumed source.
If a descendant history cannot be resumed, Trace integrity records that the
descendant source could not be reconstructed. A partial descendant
`itemsView` also marks the Trace incomplete. If live child Events already
establish that source's sequence, the Tracer preserves their causal order and
does not append older resumed history after them. A child whose start is
observed live after attachment is complete without history replay; other child
gaps are scoped only to the affected source. Root notifications stop being
accepted as soon as the observed turn terminates, before descendant replay, so
a later root turn cannot contaminate the finished Skill Run. The selected root
turn id remains pinned across reconnects, buffered or live root notifications
from another turn are ignored, and turn-less root notifications are excluded
when they cannot be attributed safely; each excluded method creates an explicit
root-source Trace Gap. Descendant replay uses the child thread creation time and
selected Root Skill turn window, retaining every causal child turn while
excluding inherited earlier work and later unrelated work. When the timestamps
needed for that decision are absent, it reports a gap instead of guessing.

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

The initial recorded run completed on 2026-08-11 with `codex-cli 0.145.0`, fixed point
`4ed8844`, and reviewed commit `5f0e14e`. The interactive `$code-review` turn
ran on thread `019ff2c8-14c7-7ab3-9472-d28e600ccbc5`, spawned the independent
Standards and Spec reviewers, completed in 165,781 ms, and reported its axes
separately. The attached live terminal observed user, agent, reasoning,
command, collaboration, resource/token, Unknown, thread, and turn activity.
Codex emitted no generic tool or File Change item for this read-only review, so
the Tracer did not invent those categories.

The first attached run exposed two real integration defects before export:
external skills can mention absent Markdown examples, and Codex 0.145.0's
structured-output endpoint rejects `oneOf` and `uniqueItems`. The final code
ignores dangling supporting-file examples, uses deterministic instruction-block
ids for exact source linkage, and uses the supported schema subset. These
changes have regression coverage.

The replacement acceptance run completed on 2026-08-11 with `codex-cli
0.145.0`, fixed point `568ce0a`, and reviewed commit `6128dfa`. Its interactive
`$code-review` turn was `019ff30d-0e90-7033-92ab-0873d6800113` on thread
`019ff305-c677-7233-81cf-38d802c4ab6b`; it completed in 193,110 ms. The two
reviewers ran on threads `019ff30d-c536-74a0-a617-eeac8f81d160` and
`019ff30d-e586-7c62-abf8-3a950d4ab029`. A sanitized copy is committed as
`test/fixtures/codex-0.145.0/live-code-review-saved-trace.json` (SHA-256
`9e55633aa6d669fd02429d532060851013e0201782dbc254dd7c277bc6c98313`). Its
terminal outcome is completed; Root Skill Attribution is developer-confirmed;
and its integrity is incomplete because attachment occurred after some
notification-only activity. The Saved Trace contains 15 replayable Events:
nine from the selected parent turn and three from the causally spawned work
turn on each reviewer source. Its 17 Findings are 16 satisfied, 1 not
applicable, 0 unobservable, and 0 violated.

The Saved Trace contains exactly the observed parent and two reviewer source
ids. No internal Evaluation Run source appears in an Event, confirming
Evaluation Run isolation for this real audit; the deterministic black-box test
verifies the same boundary with recognizable fixture ids.

The required `$code-review` found one Standards judgement call and two Spec
gaps in the checkpoint commit. The duplicated fixture instructions now derive
from the fixture Skill Contract. A sacrificial real shared-App-Server capture
now supplies sanitized failure, cancellation, disconnect/resume, and
structured-output Evaluation envelopes; deterministic fault injection remains
separate supplemental edge-case coverage. The initial empty-diff topology probe
remains excluded from acceptance.

A follow-up two-axis review of `5f0e14e...0a87778` found three further Spec
gaps and two duplication judgement calls. The follow-up fixes commit the
sanitized Saved Trace, add sanitized `thread/resume` responses from both real
reviewer children, drive Evaluation Run responses from file-backed protocol
envelopes, reject unresolved required Markdown references while retaining
explicitly optional examples, and centralize instruction-block and
fault-fixture construction. The amended black-box replay now serves and consumes
both captured child histories, asserts their causal child-source Events in the
export, scopes optional-reference wording to each reference's clause, and uses
one typed helper to materialize captured Evaluation Run envelopes.

The final trace-integrity regressions cover partial child histories and the
live/history race explicitly. Mandatory wording after an example marker still
makes the referenced Markdown required; example markers that follow a general
requirement remain optional examples. Each reference is classified from the
wording that precedes that reference, so a later optional example cannot weaken
an earlier required reference in the same sentence.
