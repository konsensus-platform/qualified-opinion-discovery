// Deterministic stand-in for a live provider. It replays a recorded script so
// the whole research flow can be exercised offline. A replayed run is a
// recording of this file's fixture, not evidence that any model was called;
// the transcript's model provider says so plainly.
import { z } from "zod";
import {
  researchOutputSchema,
  researchReasoningSchema,
  researchToolCallSchema,
} from "../schemas";
import type {
  ResearchModel,
  ResearchModelRequest,
  ResearchModelResponse,
} from "./index";

export const replayScriptSchema = z
  .object({
    modelName: z.string().trim().min(1).max(120),
    turns: z
      .array(
        z
          .object({
            reasoning: z.array(researchReasoningSchema).max(20).default([]),
            toolCalls: z.array(researchToolCallSchema).max(20).default([]),
            output: researchOutputSchema.nullable().default(null),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

export type ReplayScript = z.infer<typeof replayScriptSchema>;

export function replayResearchModel(input: unknown): ResearchModel {
  const script = replayScriptSchema.parse(input);
  let turn = 0;
  return {
    provider: "replay-fixture",
    name: script.modelName,
    parameters: { turns: script.turns.length },
    async respond(
      request: ResearchModelRequest,
    ): Promise<ResearchModelResponse> {
      const scripted = script.turns[turn];
      if (!scripted)
        throw new Error(
          `Replay script has no turn ${turn}; it defines ${script.turns.length}`,
        );
      turn += 1;
      return {
        reasoning: scripted.reasoning,
        toolCalls: scripted.toolCalls,
        output: scripted.output,
        raw: {
          replayedTurn: turn - 1,
          promptMessages: request.messages.length,
          scripted,
        },
      };
    },
  };
}

export async function loadReplayScript(path: string): Promise<ReplayScript> {
  return replayScriptSchema.parse(await Bun.file(path).json());
}
