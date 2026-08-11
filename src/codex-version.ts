import { spawn } from "node:child_process";

export const SUPPORTED_CODEX_VERSION = "0.145.0";

export async function requireSupportedCodexVersion(
  codexExecutable = "codex",
): Promise<void> {
  const version = await readCodexVersion(codexExecutable);
  if (version !== SUPPORTED_CODEX_VERSION) {
    throw new Error(
      `Agent Tracer requires exactly codex-cli ${SUPPORTED_CODEX_VERSION}; found ${version === null ? "an unrecognized version" : `codex-cli ${version}`}.`,
    );
  }
}

async function readCodexVersion(executable: string): Promise<string | null> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(
        new Error(
          `Unable to read Codex version (exit ${String(exitCode)}): ${stderr.trim()}`,
        ),
      );
    });
  });

  return /^codex-cli (\d+\.\d+\.\d+)$/.exec(output)?.[1] ?? null;
}
