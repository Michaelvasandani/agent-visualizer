# Isolate Conformance evaluation from the observed workflow

The Tracer will use separate internal Codex App Server threads to compile Obligations and produce Findings, and will exclude those Evaluation Runs from the observed Trace. Reusing the observed thread would contaminate the behavior being audited, while direct API calls or separate `codex exec` processes would introduce another authentication or process-integration path. Isolated threads preserve passive observation while reusing the shared server and existing Codex authentication.
