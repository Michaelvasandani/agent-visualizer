#!/usr/bin/env node

import { createInterface } from "node:readline/promises";

import { requireSupportedCodexVersion } from "./codex-version.js";
import { traceLoadedThread } from "./live-trace.js";
import { replaySavedTrace } from "./saved-trace.js";
import { runForegroundSharedServer } from "./shared-server.js";

async function main(args: readonly string[]): Promise<void> {
  const command = args[0];
  if (command !== "trace" && command !== "server" && command !== "replay") {
    throw new Error("Usage: agent-tracer <server|trace|replay>");
  }

  if (command === "replay") {
    const inputPath = readOption(args.slice(1), "--file");
    await replaySavedTrace(inputPath, (line) =>
      process.stdout.write(`${line}\n`),
    );
    return;
  }

  await requireSupportedCodexVersion();

  if (command === "trace") {
    const serverUrl = readOption(args.slice(1), "--server");
    const exportPath = readOptionalOption(args.slice(1), "--export");
    await traceLoadedThread(
      serverUrl,
      (line) => process.stdout.write(`${line}\n`),
      promptForLoadedThread,
      promptForHistoricalRootSkill,
      exportPath,
    );
    return;
  }

  const serverUrl = readOptionalOption(args.slice(1), "--listen");
  process.exitCode = await runForegroundSharedServer(
    serverUrl,
    (line) => process.stdout.write(`${line}\n`),
  );
}

async function promptForHistoricalRootSkill(
  rootSkill: { readonly name: string; readonly path: string },
): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(
      `Confirm inferred Root Skill ${JSON.stringify(rootSkill.name)} at ${rootSkill.path} [y/N]: `,
    );
    return answer.trim().toLowerCase() === "y";
  } finally {
    prompt.close();
  }
}

async function promptForLoadedThread(
  threadIds: readonly string[],
): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = await prompt.question(
        `Select a loaded thread [1-${threadIds.length}]: `,
      );
      const selectedIndex = Number(answer.trim()) - 1;
      const selectedThreadId = threadIds[selectedIndex];
      if (Number.isInteger(selectedIndex) && selectedThreadId !== undefined) {
        return selectedThreadId;
      }
      process.stdout.write("Enter one of the listed thread numbers.\n");
    }
  } finally {
    prompt.close();
  }
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
