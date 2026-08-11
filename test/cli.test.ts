import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocketServer } from "ws";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const cliPath = path.join(repositoryRoot, "src", "cli.ts");

interface CliResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(
  args: readonly string[],
  options: {
    readonly codexVersion: string;
    readonly codexBehavior?: string;
    readonly stdin?: string;
  },
): Promise<CliResult> {
  const binDirectory = await mkdtemp(path.join(tmpdir(), "agent-tracer-bin-"));
  const codexPath = path.join(binDirectory, "codex");
  await writeFile(
    codexPath,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo '${options.codexVersion}'\n  exit 0\nfi\n${options.codexBehavior ?? ""}\nexit 64\n`,
  );
  await chmod(codexPath, 0o755);

  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", cliPath, ...args],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stdin.end(options.stdin);
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 3_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

test("rejects an unsupported Codex version before observation", async () => {
  const result = await runCli(["trace", "--server", "ws://127.0.0.1:1"], {
    codexVersion: "codex-cli 0.146.0",
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /requires exactly codex-cli 0\.145\.0/i);
  assert.doesNotMatch(result.stderr, /ECONNREFUSED/);
});

test("traces the only loaded thread through a fake App Server", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      requests.push(request);
      const id = request.id;

      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id,
            result: {
              userAgent:
                "agent-tracer/0.145.0 (Mac OS 14.6.1; arm64) vscode/1.130.0 (agent-tracer; 0.1.0)",
              codexHome: "/tmp/codex-home",
              platformFamily: "unix",
              platformOs: "macos",
            },
          }),
        );
        return;
      }
      if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id,
            result: { data: ["thread-one"], nextCursor: null },
          }),
        );
        return;
      }
      if (request.method === "thread/resume") {
        socket.send(
          JSON.stringify({
            id,
            result: { thread: { id: "thread-one", turns: [] } },
          }),
        );

        setImmediate(() => {
          socket.send(
            JSON.stringify({
              method: "item/started",
              params: {
                threadId: "thread-one",
                turnId: "turn-one",
                startedAtMs: 100,
                item: {
                  type: "userMessage",
                  id: "user-one",
                  clientId: "client-one",
                  content: [{ type: "text", text: "trace this proprietary prompt" }],
                },
              },
            }),
          );
          socket.send(
            JSON.stringify({
              method: "item/completed",
              params: {
                threadId: "thread-other",
                turnId: "turn-other",
                completedAtMs: 110,
                item: {
                  type: "commandExecution",
                  id: "not-observed",
                  command: "must-not-appear",
                },
              },
            }),
          );
          socket.send(
            JSON.stringify({
              method: "item/completed",
              params: {
                threadId: "thread-one",
                turnId: "turn-one",
                completedAtMs: 130,
                item: {
                  type: "webSearch",
                  id: "search-one",
                  query: "private search terms",
                  action: { type: "search", query: "private search terms" },
                },
              },
            }),
          );
          socket.send(
            JSON.stringify({
              method: "item/completed",
              params: {
                threadId: "thread-one",
                turnId: "turn-one",
                completedAtMs: 140,
                item: {
                  type: "imageGeneration",
                  id: "image-one",
                  revisedPrompt: "private image prompt",
                  result: "data:image/png;base64,unredacted",
                },
              },
            }),
          );
          socket.send(
            JSON.stringify({
              method: "item/completed",
              params: {
                threadId: "thread-one",
                turnId: "turn-one",
                completedAtMs: 120,
                item: {
                  type: "mcpToolCall",
                  id: "tool-one",
                  server: "example",
                  tool: "lookup",
                  status: "completed",
                  arguments: { token: "secret-tool-argument" },
                  result: { content: [{ type: "text", text: "tool result" }] },
                  durationMs: 20,
                },
              },
            }),
          );
          socket.send(
            JSON.stringify({
              method: "item/completed",
              params: {
                threadId: "thread-one",
                turnId: "turn-one",
                completedAtMs: 150,
                item: {
                  type: "commandExecution",
                  id: "command-one",
                  command: "pwd",
                  cwd: "/workspace/private",
                  status: "completed",
                  aggregatedOutput: "/workspace/private\n",
                  exitCode: 0,
                  durationMs: 30,
                },
              },
            }),
          );
          socket.send(
            JSON.stringify({
              method: "turn/completed",
              params: {
                threadId: "thread-one",
                turn: { id: "turn-one", status: "completed", items: [] },
              },
            }),
          );
        });
        return;
      }
      if (request.method === "thread/unsubscribe") {
        socket.send(JSON.stringify({ id, result: {} }));
      }
    });
  });

  const address = server.address() as AddressInfo;
  const result = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0" },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /WARNING.*UNREDACTED SENSITIVE INFORMATION/i);
  assert.match(result.stdout, /sent unredacted\s+to OpenAI/i);
  assert.match(result.stdout, /automatically selected.*thread-one/i);
  assert.match(result.stdout, /^\[user\] item\/started .*proprietary prompt/m);
  assert.match(result.stdout, /^\[tool\] item\/completed .*secret-tool-argument.*tool result/m);
  assert.match(result.stdout, /^\[tool\] item\/completed .*private search terms/m);
  assert.match(result.stdout, /^\[tool\] item\/completed .*private image prompt/m);
  assert.match(
    result.stdout,
    /^\[command\] item\/completed .*"command":"pwd".*"cwd":"\/workspace\/private".*"aggregatedOutput":"\/workspace\/private\\n".*"exitCode":0.*"durationMs":30/m,
  );
  assert.doesNotMatch(result.stdout, /must-not-appear/);

  assert.deepEqual(
    requests.map((request) => request.method),
    [
      "initialize",
      "initialized",
      "thread/loaded/list",
      "thread/resume",
      "thread/unsubscribe",
    ],
  );
  assert.deepEqual(requests[3]?.params, { threadId: "thread-one" });
});

test("requires an explicit selection when multiple threads are loaded", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      requests.push(request);
      const id = request.id;

      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id,
            result: {
              userAgent: "agent-tracer/0.145.0 (Mac OS; arm64)",
            },
          }),
        );
        return;
      }
      if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id,
            result: {
              data: ["thread-most-recent", "thread-intended"],
              nextCursor: null,
            },
          }),
        );
        return;
      }
      if (request.method === "thread/resume") {
        socket.send(
          JSON.stringify({
            id,
            result: { thread: { id: "thread-intended", turns: [] } },
          }),
        );
        setImmediate(() => {
          socket.send(
            JSON.stringify({
              method: "turn/completed",
              params: {
                threadId: "thread-intended",
                turn: { id: "turn-one", status: "completed", items: [] },
              },
            }),
          );
        });
        return;
      }
      if (request.method === "thread/unsubscribe") {
        socket.send(JSON.stringify({ id, result: { status: "unsubscribed" } }));
      }
    });
  });

  const address = server.address() as AddressInfo;
  const result = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0", stdin: "2\n" },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /1\. thread-most-recent/);
  assert.match(result.stdout, /2\. thread-intended/);
  assert.match(result.stdout, /Select a loaded thread \[1-2\]:/);
  assert.match(result.stdout, /Selected loaded thread: thread-intended/);
  assert.deepEqual(requests[3]?.params, { threadId: "thread-intended" });
  assert.equal(
    requests.some((request) =>
      ["turn/start", "turn/steer", "turn/interrupt"].includes(
        String(request.method),
      ),
    ),
    false,
  );
});

test("replays history before live activity without duplicating Events", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      requests.push(request);
      const id = request.id;

      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id,
            result: { userAgent: "agent-tracer/0.145.0 (Mac OS; arm64)" },
          }),
        );
        return;
      }
      if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id,
            result: { data: ["thread-one"], nextCursor: null },
          }),
        );
        return;
      }
      if (request.method === "thread/resume") {
        socket.send(
          JSON.stringify({
            method: "item/started",
            params: {
              threadId: "thread-one",
              turnId: "turn-one",
              startedAtMs: 100,
              item: {
                type: "userMessage",
                id: "user-history",
                clientId: "client-one",
                content: [{ type: "text", text: "historical prompt" }],
              },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "item/completed",
            params: {
              threadId: "thread-one",
              turnId: "turn-one",
              completedAtMs: 120,
              item: {
                type: "commandExecution",
                id: "command-history",
                command: "echo historical-secret",
                cwd: "/workspace",
                status: "completed",
                aggregatedOutput: "historical-secret\n",
                exitCode: 0,
                durationMs: 10,
              },
            },
          }),
        );
        for (const [itemId, method, completedAtMs] of [
          ["concurrent-a", "item/started", 124],
          ["concurrent-b", "item/completed", 126],
          ["concurrent-a", "item/completed", 127],
        ] as const) {
          socket.send(
            JSON.stringify({
              method,
              params: {
                threadId: "thread-one",
                turnId: "turn-one",
                ...(method === "item/started"
                  ? { startedAtMs: completedAtMs }
                  : { completedAtMs }),
                item: {
                  type: "mcpToolCall",
                  id: itemId,
                  server: "example",
                  tool: "concurrent",
                  status: method === "item/started" ? "inProgress" : "completed",
                  arguments: { itemId },
                  result: { content: [{ type: "text", text: itemId }] },
                  durationMs: 15,
                },
              },
            }),
          );
        }
        socket.send(
          JSON.stringify({
            method: "item/completed",
            params: {
              threadId: "thread-one",
              turnId: "turn-one",
              completedAtMs: 125,
              item: {
                type: "mcpToolCall",
                id: "tool-progress",
                server: "example",
                tool: "long-running",
                status: "completed",
                arguments: { value: "finished-live" },
                result: {
                  content: [{ type: "text", text: "finished result" }],
                },
                durationMs: 20,
              },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            method: "item/completed",
            params: {
              threadId: "thread-one",
              turnId: "turn-one",
              completedAtMs: 130,
              item: {
                type: "mcpToolCall",
                id: "tool-live",
                server: "example",
                tool: "lookup",
                status: "completed",
                arguments: { value: "live-secret" },
                result: { content: [{ type: "text", text: "live result" }] },
                durationMs: 5,
              },
            },
          }),
        );
        socket.send(
          JSON.stringify({
            id,
            result: {
              thread: {
                id: "thread-one",
                turns: [
                  {
                    id: "turn-one",
                    status: "inProgress",
                    items: [
                      {
                        type: "userMessage",
                        id: "user-history",
                        clientId: "client-one",
                        content: [
                          { type: "text", text: "historical prompt" },
                        ],
                      },
                      {
                        type: "commandExecution",
                        id: "command-history",
                        command: "echo historical-secret",
                        cwd: "/workspace",
                        status: "completed",
                        aggregatedOutput: "historical-secret\n",
                        exitCode: 0,
                        durationMs: 10,
                      },
                      {
                        type: "mcpToolCall",
                        id: "tool-progress",
                        server: "example",
                        tool: "long-running",
                        status: "inProgress",
                        arguments: { value: "started-in-history" },
                        result: null,
                        durationMs: null,
                      },
                      ...["concurrent-a", "concurrent-b"].map((itemId) => ({
                        type: "mcpToolCall",
                        id: itemId,
                        server: "example",
                        tool: "concurrent",
                        status: "completed",
                        arguments: { itemId },
                        result: { content: [{ type: "text", text: itemId }] },
                        durationMs: 15,
                      })),
                    ],
                  },
                ],
              },
            },
          }),
        );
        setImmediate(() => {
          socket.send(
            JSON.stringify({
              method: "turn/completed",
              params: {
                threadId: "thread-one",
                turn: { id: "turn-one", status: "completed", items: [] },
              },
            }),
          );
        });
        return;
      }
      if (request.method === "thread/unsubscribe") {
        socket.send(JSON.stringify({ id, result: { status: "unsubscribed" } }));
      }
    });
  });

  const address = server.address() as AddressInfo;
  const result = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0" },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  const historicalPromptIndex = result.stdout.indexOf("historical prompt");
  const liveActivityIndex = result.stdout.indexOf("live-secret");
  assert.notEqual(historicalPromptIndex, -1, result.stdout);
  assert.notEqual(liveActivityIndex, -1, result.stdout);
  assert.ok(historicalPromptIndex < liveActivityIndex, result.stdout);
  assert.equal(result.stdout.match(/echo historical-secret/g)?.length, 1);
  assert.equal(result.stdout.match(/historical prompt/g)?.length, 1);
  assert.match(result.stdout, /"completedAtMs":120/);
  assert.match(
    result.stdout,
    /event=thread-one\/turn-one\/user-history\/started source=thread-one sequence=1 parent=thread-one\/turn-one/,
  );
  assert.match(
    result.stdout,
    /event=thread-one\/turn-one\/command-history\/completed source=thread-one sequence=2 parent=thread-one\/turn-one/,
  );
  assert.match(
    result.stdout,
    /event=thread-one\/turn-one\/tool-progress\/started source=thread-one sequence=3 parent=thread-one\/turn-one/,
  );
  assert.match(
    result.stdout,
    /event=thread-one\/turn-one\/concurrent-a\/started source=thread-one sequence=4 parent=thread-one\/turn-one/,
  );
  assert.match(
    result.stdout,
    /event=thread-one\/turn-one\/concurrent-b\/completed source=thread-one sequence=5 parent=thread-one\/turn-one/,
  );
  assert.match(
    result.stdout,
    /event=thread-one\/turn-one\/concurrent-a\/completed source=thread-one sequence=6 parent=thread-one\/turn-one/,
  );
  assert.match(
    result.stdout,
    /event=thread-one\/turn-one\/tool-progress\/completed source=thread-one sequence=7 parent=thread-one\/turn-one/,
  );
  assert.match(
    result.stdout,
    /event=thread-one\/turn-one\/tool-live\/completed source=thread-one sequence=8 parent=thread-one\/turn-one/,
  );
  assert.deepEqual(
    requests.map((request) => request.method),
    [
      "initialize",
      "initialized",
      "thread/loaded/list",
      "thread/resume",
      "thread/unsubscribe",
    ],
  );
});

test("finishes from terminal history when completion raced attachment", async (t) => {
  const methods: string[] = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      methods.push(String(request.method));
      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { userAgent: "agent-tracer/0.145.0 (Mac OS; arm64)" },
          }),
        );
      } else if (request.method === "thread/loaded/list") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { data: ["thread-one"], nextCursor: null },
          }),
        );
      } else if (request.method === "thread/resume") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              thread: {
                id: "thread-one",
                turns: [
                  {
                    id: "turn-one",
                    status: "completed",
                    items: [
                      {
                        type: "userMessage",
                        id: "user-one",
                        content: [{ type: "text", text: "finished in history" }],
                      },
                    ],
                  },
                ],
              },
            },
          }),
        );
      } else if (request.method === "thread/unsubscribe") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: { status: "unsubscribed" },
          }),
        );
      }
    });
  });

  const address = server.address() as AddressInfo;
  const result = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0" },
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /finished in history/);
  assert.deepEqual(methods, [
    "initialize",
    "initialized",
    "thread/loaded/list",
    "thread/resume",
    "thread/unsubscribe",
  ]);
});

test("rejects an unsupported App Server before listing threads", async (t) => {
  const methods: string[] = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => server.close());

  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      if (typeof request.method === "string") methods.push(request.method);
      if (request.method === "initialize") {
        socket.send(
          JSON.stringify({
            id: request.id,
            result: {
              userAgent: "agent-tracer/0.146.0 (Mac OS; arm64)",
              codexHome: "/tmp/codex-home",
              platformFamily: "unix",
              platformOs: "macos",
            },
          }),
        );
      }
    });
  });

  const address = server.address() as AddressInfo;
  const result = await runCli(
    ["trace", "--server", `ws://127.0.0.1:${address.port}`],
    { codexVersion: "codex-cli 0.145.0" },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /requires exactly Codex App Server 0\.145\.0/);
  assert.deepEqual(methods, ["initialize"]);
});

test("starts and owns a foreground shared App Server", async () => {
  const result = await runCli(
    ["server", "--listen", "ws://127.0.0.1:4555"],
    {
      codexVersion: "codex-cli 0.145.0",
      codexBehavior:
        'if [ "$1" = "app-server" ]; then\n  echo "fake app server: $*"\n  exit 23\nfi',
    },
  );

  assert.equal(result.exitCode, 23, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(
    result.stdout,
    /Connect the interactive Codex TUI with:\ncodex --remote ws:\/\/127\.0\.0\.1:4555/,
  );
  assert.match(
    result.stdout,
    /fake app server: app-server --listen ws:\/\/127\.0\.0\.1:4555/,
  );
});
