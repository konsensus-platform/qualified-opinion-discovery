import type {
  ResearchMessage,
  ResearchOutput,
  ResearchReasoning,
  ResearchToolCall,
} from "../schemas";

export type ResearchModelRequest = {
  system: string;
  messages: ResearchMessage[];
  toolNames: ("search" | "fetch")[];
};

export type ResearchModelResponse = {
  // Whatever the provider returned under the name "reasoning", tagged with what
  // it actually is. An empty array means the provider returned none.
  reasoning: ResearchReasoning[];
  toolCalls: ResearchToolCall[];
  // Set once the model emits its final structured answer.
  output: ResearchOutput | null;
  // The provider response exactly as received. Recorded without interpretation
  // so a reader is not limited to this runtime's parse of it.
  raw: unknown;
};

export interface ResearchModel {
  readonly provider: string;
  readonly name: string;
  readonly parameters: Record<string, unknown>;
  respond(request: ResearchModelRequest): Promise<ResearchModelResponse>;
}
