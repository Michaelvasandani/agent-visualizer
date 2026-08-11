# Preserve unredacted Trace content

The Tracer will display, optionally save, and send to the OpenAI-backed Conformance evaluator the complete unredacted payloads reported by Codex. Automatic redaction would reduce accidental disclosure but can remove behaviorally significant evidence and cannot guarantee that every secret is recognized. The CLI must prominently warn developers that Traces may contain credentials, proprietary content, personal data, and other sensitive information; persistence remains explicit rather than automatic.
