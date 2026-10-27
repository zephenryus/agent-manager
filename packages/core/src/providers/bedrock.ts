// Bedrock provider via the Vercel AI SDK (v5 API) -- UNVERIFIED until run with real packages + credentials.
// Only this file imports the AI SDK. Credentials come from the standard AWS chain for the named profile.
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { generateText, jsonSchema, tool } from "ai";
import type { ModelMessage, ToolSet } from "ai";
import { ProviderAuthError } from "../types.ts";
import type { Message, ModelRequest, ModelResponse, Provider } from "../types.ts";

export type BedrockOptions = {
  profile: string;
  region: string;
  modelId: string;
};

export function createBedrockProvider(opts: BedrockOptions): Provider {
  const bedrock = createAmazonBedrock({
    region: opts.region,
    credentialProvider: fromNodeProviderChain({ profile: opts.profile }),
  });
  const model = bedrock(opts.modelId);

  return {
    id: `bedrock:${opts.modelId}`,
    async complete(req: ModelRequest): Promise<ModelResponse> {
      const tools: ToolSet = {};
      for (const t of req.tools) {
        // No `execute`: the core turn loop runs tools, so the model call is exactly one step.
        tools[t.name] = tool({ description: t.description, inputSchema: jsonSchema(t.inputSchema) });
      }
      try {
        const result = await generateText({
          model,
          system: req.system,
          messages: req.messages.map(toModelMessage),
          tools,
          maxOutputTokens: req.maxOutputTokens,
        });
        return {
          text: result.text,
          toolCalls: result.toolCalls.map((c) => ({
            id: c.toolCallId,
            name: c.toolName,
            input: (c.input ?? {}) as Record<string, unknown>,
          })),
          usage: {
            inputTokens: result.usage.inputTokens ?? 0,
            outputTokens: result.usage.outputTokens ?? 0,
          },
          stopReason: result.finishReason,
        };
      } catch (err) {
        throw translateError(err, opts.profile);
      }
    },
  };
}

function toModelMessage(m: Message): ModelMessage {
  switch (m.role) {
    case "user":
      return { role: "user", content: m.text };
    case "assistant":
      return {
        role: "assistant",
        content: [
          ...(m.text ? [{ type: "text" as const, text: m.text }] : []),
          ...m.toolCalls.map((c) => ({
            type: "tool-call" as const,
            toolCallId: c.id,
            toolName: c.name,
            input: c.input,
          })),
        ],
      };
    case "tool":
      return {
        role: "tool",
        content: m.results.map((r) => ({
          type: "tool-result" as const,
          toolCallId: r.id,
          toolName: r.name,
          output: r.isError
            ? { type: "error-text" as const, value: r.output }
            : { type: "text" as const, value: r.output },
        })),
      };
  }
}

function translateError(err: unknown, profile: string): unknown {
  const text = [
    err instanceof Error ? err.name : "",
    err instanceof Error ? err.message : String(err),
    // AI SDK wraps provider failures; look at the cause chain too.
    err instanceof Error && err.cause instanceof Error ? `${err.cause.name} ${err.cause.message}` : "",
  ].join(" ");
  if (/expired|credential|ExpiredToken|UnrecognizedClient|security token|SSO/i.test(text)) {
    return new ProviderAuthError(
      `AWS credentials for profile "${profile}" are missing or expired.`,
      "Refresh your credentials (gimme-aws-creds / Apono, whichever your org uses) and retry.",
    );
  }
  return err;
}
