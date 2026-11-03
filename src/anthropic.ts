import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlock, ModelClient } from "./agent.js";

/** Wraps the Anthropic SDK and strips responses down to plain text/tool_use blocks, which is all we store. */
export function createAnthropicModel(apiKey: string): ModelClient {
  const client = new Anthropic({ apiKey, maxRetries: 3 });
  return {
    async create(req) {
      const res = await client.messages.create({
        model: req.model,
        max_tokens: req.max_tokens,
        system: req.system,
        tools: req.tools as any,
        messages: req.messages as any,
      });
      const content: ContentBlock[] = [];
      for (const b of res.content) {
        if (b.type === "text") content.push({ type: "text", text: b.text });
        else if (b.type === "tool_use") content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
      }
      return { content, stop_reason: res.stop_reason };
    },
  };
}
