#!/usr/bin/env node

import { requireSupportedCodexVersion } from "./codex-version.js";
import { traceOnlyLoadedThread } from "./live-trace.js";
import { runForegroundSharedServer } from "./shared-server.js";

async function main(args: readonly string[]): Promise<void> {
  const command = args[0];
  if (command !== "trace" && command !== "server") {
    throw new Error("Usage: agent-tracer <server|trace>");
  }

  await requireSupportedCodexVersion();

  if (command === "trace") {
    const serverUrl = readOption(args.slice(1), "--server");
    await traceOnlyLoadedThread(serverUrl, (line) => process.stdout.write(`${line}\n`));
    return;
  }

  const serverUrl = readOptionalOption(args.slice(1), "--listen");
  process.exitCode = await runForegroundSharedServer(
    serverUrl,
    (line) => process.stdout.write(`${line}\n`),
  );
}

function readOption(args: readonly string[], name: string): string {
  const optionIndex = args.indexOf(name);
  const value = args[optionIndex + 1];
  if (optionIndex === -1 || value === undefined || value.startsWith("--")) {
    throw new Error(`Missing required option ${name}.`);
  }
  return value;
}

function readOptionalOption(
  args: readonly string[],
  name: string,
): string | undefined {
  const optionIndex = args.indexOf(name);
  if (optionIndex === -1) return undefined;
  const value = args[optionIndex + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for option ${name}.`);
  }
  return value;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
