import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

test("extension waits for settlement, continues once, then switches and persists recovery", async () => {
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
    const messages: Array<{ customType: string; options: unknown }> = [];
    const selected: string[] = [];
    const statuses: string[] = [];
    let command: unknown;

    const context = {
      cwd: agentDir,
      mode: "tui",
      hasUI: true,
      model: modelA,
      modelRegistry: {
        refresh: async () => undefined,
        getAll: () => [modelA, modelB],
        getAvailable: () => [modelA, modelB],
        find: (provider: string, id: string) =>
          [modelA, modelB].find(
            (model) => model.provider === provider && model.id === id,
          ),
      },
      ui: {
        setStatus: (_id: string, value: string) => statuses.push(value),
        notify: () => undefined,
        custom: async () => undefined,
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
        command = definition;
      },
      setModel: async (model: Model) => {
        selected.push(`${model.provider}/${model.id}`);
        return true;
      },
      sendMessage: (message: { customType: string }, options: unknown) => {
        messages.push({ customType: message.customType, options });
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

    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.customType, "model-failover-continuation");
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

    await emit("agent_start", {});
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

    assert.deepEqual(selected, ["provider-b/model-b"]);
    assert.equal(messages.length, 2);
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
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});
