import { spawn } from "node:child_process";

const DEFAULT_SERVER_URL = "ws://127.0.0.1:4500";

export async function runForegroundSharedServer(
  serverUrl = DEFAULT_SERVER_URL,
  writeLine: (line: string) => void,
): Promise<number> {
  writeLine("Starting the shared Codex App Server in the foreground.");
  writeLine("Connect the interactive Codex TUI with:");
  writeLine(`codex --remote ${serverUrl}`);

  const child = spawn("codex", ["app-server", "--listen", serverUrl], {
    stdio: "inherit",
  });

  const forwardSignal = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  const onSigint = (): void => forwardSignal("SIGINT");
  const onSigterm = (): void => forwardSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => resolve(exitCode ?? 1));
    });
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}
