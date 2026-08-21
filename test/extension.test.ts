import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type Handler = (event: unknown, context: unknown) => unknown;
type Model = NonNullable<ExtensionContext["model"]>;

function makeModel(provider: string, id: string): Model {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://example.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32_000,
    maxTokens: 4_096,
  } as Model;
}

test("extension switches message-only 502 directly and preserves settled failover behavior", async () => {
  const agentDir = await mkdtemp(
    join(tmpdir(), "pi-model-failover-extension-"),
  );
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    const { default: registerExtension } = await import("../src/index.ts");
    const modelA = makeModel("provider-a", "model-a");
    const modelB = makeModel("provider-b", "model-b");
    const handlers = new Map<string, Handler[]>();
    const messages: Array<{
      customType: string;
      details: unknown;
      options: unknown;
    }> = [];
    const selected: string[] = [];
    const statuses: string[] = [];
    const notifications: string[] = [];
    let customCalls = 0;
    let availableModels = [modelA, modelB];
    let refreshError: Error | undefined;
    let command:
      | { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
      | undefined;

    const context = {
      cwd: agentDir,
      mode: "tui",
      hasUI: true,
      model: modelA,
      modelRegistry: {
        refresh: async () => {
          if (refreshError) throw refreshError;
        },
        getAll: () => [modelA, modelB],
        getAvailable: () => availableModels,
        find: (provider: string, id: string) =>
          [modelA, modelB].find(
            (model) => model.provider === provider && model.id === id,
          ),
      },
      ui: {
        setStatus: (_id: string, value: string) => statuses.push(value),
        notify: (message: string) => notifications.push(message),
        custom: async () => {
          customCalls++;
        },
        select: async () => undefined,
        input: async () => undefined,
      },
      isIdle: () => false,
      abort: () => undefined,
    } as unknown as ExtensionContext;

    const pi = {
      on: (event: string, handler: Handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerCommand: (_name: string, definition: unknown) => {
        command = definition as typeof command;
      },
      setModel: async (model: Model) => {
        selected.push(`${model.provider}/${model.id}`);
        return true;
      },
      setThinkingLevel: () => undefined,
      sendMessage: (
        message: { customType: string; details?: unknown },
        options: unknown,
      ) => {
        messages.push({
          customType: message.customType,
          details: message.details,
          options,
        });
      },
    } as unknown as ExtensionAPI;

    registerExtension(pi);
    assert.ok(command);

    const emit = async (event: string, value: unknown): Promise<unknown[]> => {
      const results: unknown[] = [];
      for (const handler of handlers.get(event) ?? []) {
        results.push(await handler(value, context));
      }
      return results;
    };

    await emit("session_start", { reason: "startup" });
    assert.ok(command);
    const configPath = join(agentDir, "model-failover.json");
    const firstRun = JSON.parse(await readFile(configPath, "utf8")) as {
      models: Array<{ provider: string; id: string }>;
    };
    assert.deepEqual(firstRun.models, [
      { provider: "provider-a", id: "model-a" },
    ]);

    await unlink(configPath);
    context.model = undefined;
    await emit("session_start", { reason: "startup" });
    const noCurrent = JSON.parse(await readFile(configPath, "utf8")) as {
      models: unknown[];
    };
    assert.deepEqual(noCurrent.models, []);

    context.model = modelA;
    const configured = {
      ...JSON.parse(await readFile(configPath, "utf8")),
      models: [
        { provider: "provider-a", id: "model-a" },
        { provider: "provider-b", id: "model-b" },
      ],
    };
    const configuredBytes = `${JSON.stringify(configured, null, 2)}\n`;
    await writeFile(configPath, configuredBytes);
    availableModels = [modelB];
    await emit("session_start", { reason: "startup" });
    assert.equal(await readFile(configPath, "utf8"), configuredBytes);

    refreshError = new Error("offline");
    await emit("session_start", { reason: "startup" });
    assert.equal(await readFile(configPath, "utf8"), configuredBytes);
    assert.ok(notifications.some((message) => message.includes("offline")));
    refreshError = undefined;
    availableModels = [];
    await emit("session_start", { reason: "startup" });
    assert.equal(await readFile(configPath, "utf8"), configuredBytes);
    availableModels = [modelA, modelB];
    await emit("before_agent_start", { prompt: "502" });
    await emit("agent_start", {});
    await emit("agent_end", {
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "OpenAI API error (502): upstream access forbidden",
        },
      ],
    });
    await emit("agent_settled", {});

    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0]?.details, {
      model: { provider: "provider-a", id: "model-a" },
      kind: "same",
    });

    await emit("before_agent_start", { prompt: "continuation" });
    await emit("agent_start", {});
    await emit("agent_end", {
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "OpenAI API error (502): upstream access forbidden",
        },
      ],
    });
    await emit("agent_settled", {});

    assert.deepEqual(selected, ["provider-b/model-b"]);
    assert.deepEqual(messages[1]?.details, {
      model: { provider: "provider-b", id: "model-b" },
      kind: "switch",
    });

    await emit("before_agent_start", { prompt: "continuation" });
    await emit("agent_start", {});
    await emit("agent_end", {
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    await emit("agent_settled", {});

    await emit("model_select", { model: modelA, source: "restore" });
    await emit("before_agent_start", { prompt: "hello" });
    await emit("agent_start", {});
    await emit("agent_end", {
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "temporary provider failure",
        },
      ],
    });
    await emit("agent_settled", {});

    assert.equal(messages.length, 3);
    assert.equal(messages[1]?.customType, "model-failover-continuation");
    await emit("before_agent_start", { prompt: "continuation" });
    await emit("agent_start", {});
    assert.deepEqual(
      (
        await emit("context", {
          messages: [
            { role: "user", content: [{ type: "text", text: "hello" }] },
            {
              role: "assistant",
              stopReason: "error",
              errorMessage: "temporary provider failure",
            },
          ],
        })
      )[0],
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ],
      },
    );

    await emit("agent_end", {
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "quota exceeded",
        },
      ],
    });
    await emit("agent_settled", {});

    assert.deepEqual(selected, ["provider-b/model-b", "provider-b/model-b"]);
    assert.equal(messages.length, 4);
    const persisted = JSON.parse(
      await readFile(join(agentDir, "model-failover.json"), "utf8"),
    ) as {
      manualRecovery: Record<string, string>;
    };
    assert.equal(
      persisted.manualRecovery["provider-a/model-a"],
      "balance/quota/usage failure",
    );
    assert.ok(statuses.some((status) => status.includes("provider-b/model-b")));

    const beforeBlockedMessages = messages.length;
    const beforeBlockedUi = customCalls;
    await writeFile(configPath, "{broken", "utf8");
    await command.handler("", context);
    assert.equal(customCalls, beforeBlockedUi);
    assert.ok(statuses.at(-1)?.startsWith("disabled"));
    assert.ok(
      notifications.some(
        (message) =>
          message.includes(configPath) && message.includes("Repair or restore"),
      ),
    );
    const blockedPayload: Record<string, unknown> = {};
    await emit("before_provider_request", { payload: blockedPayload });
    assert.deepEqual(blockedPayload, {});
    await emit("before_agent_start", { prompt: "must not arm" });
    await emit("agent_start", {});
    await emit("agent_end", {
      messages: [
        { role: "assistant", stopReason: "error", errorMessage: "502" },
      ],
    });
    await emit("agent_settled", {});
    assert.equal(messages.length, beforeBlockedMessages);

    await writeFile(configPath, configuredBytes, "utf8");
    await command.handler("", context);
    assert.equal(customCalls, beforeBlockedUi + 1);

    for (const blocked of [
      JSON.stringify({ version: 3 }),
      JSON.stringify({ ...configured, version: 6 }),
    ]) {
      await writeFile(configPath, blocked, "utf8");
      await command.handler("", context);
      assert.equal(customCalls, beforeBlockedUi + 1);
      assert.ok(statuses.at(-1)?.startsWith("disabled"));
    }

    await rm(configPath);
    await mkdir(configPath);
    await command.handler("", context);
    assert.equal(customCalls, beforeBlockedUi + 1);
    assert.ok(
      notifications.some((message) => message.includes("storage access")),
    );
    await rm(configPath, { recursive: true });

    await writeFile(
      configPath,
      `${JSON.stringify({ ...configured, version: 2 }, null, 2)}\n`,
    );
    await command.handler("", context);
    const migrated = JSON.parse(await readFile(configPath, "utf8")) as {
      version: number;
      models: unknown[];
    };
    assert.equal(migrated.version, 5);
    assert.deepEqual(migrated.models, configured.models);
    assert.equal(customCalls, beforeBlockedUi + 2);
    assert.ok(statuses.at(-1)?.startsWith("enabled"));
    await emit("agent_start", {});
    await emit("agent_end", {
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "OpenAI API error (502): temporary failure",
        },
      ],
    });
    await emit("agent_settled", {});
    const beforeFailedSaveMessages = messages.length;

    await rm(configPath);
    await writeFile(`${configPath}.lock`, "foreign", "utf8");
    await command.handler("", context);
    assert.ok(statuses.at(-1)?.startsWith("disabled"));
    assert.equal(customCalls, beforeBlockedUi + 2);
    assert.deepEqual(
      await emit("context", {
        messages: [
          {
            role: "assistant",
            stopReason: "error",
            errorMessage: "must remain",
          },
        ],
      }),
      [undefined],
    );
    assert.equal(messages.length, beforeFailedSaveMessages);
    await unlink(`${configPath}.lock`);

    const migrationFailureBytes = `${JSON.stringify(
      {
        ...configured,
        version: 2,
      },
      null,
      2,
    )}\n`;
    await writeFile(configPath, migrationFailureBytes, "utf8");
    await writeFile(`${configPath}.lock`, "foreign", "utf8");
    await command.handler("", context);
    assert.equal(await readFile(configPath, "utf8"), migrationFailureBytes);
    assert.equal(customCalls, beforeBlockedUi + 2);
    assert.ok(statuses.at(-1)?.startsWith("disabled"));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});
