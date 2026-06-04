import { AgentLoop, AgentIO } from "../agent/loop";
import { createInitialState } from "../agent/state";
import { ProviderFactory } from "../provider/factory";
import { LLMMessage, LLMProvider, LLMResponse } from "../types";

// ── Mock Provider ─────────────────────────────────────────────────

class MockProvider implements LLMProvider {
  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    const system = messages.find((m) => m.role === "system")?.content ?? "";

    if (system.includes("Skill level assessor")) {
      return {
        text: JSON.stringify({
          level: "some",
          masteredConcepts: ["variables", "loops"],
          needMoreProbing: false,
          nextQuestion: "",
        }),
      };
    }

    if (system.includes("Curriculum author")) {
      return {
        text: JSON.stringify({
          chapters: [
            { id: "ch1", title: "Functions",   body: "Functions are reusable blocks." },
            { id: "ch2", title: "Classes",     body: "Classes enable OOP patterns."  },
            { id: "ch3", title: "Async/Await", body: "Async handles async operations." },
          ],
        }),
      };
    }

    if (system.includes("Learning path planner")) {
      return {
        text: JSON.stringify({
          options: [
            { key: "practice-first", label: "Start with hands-on examples" },
            { key: "concept-first",  label: "Start with theory" },
          ],
          recommendation: "Given your experience, practice-first suits you.",
        }),
      };
    }

    if (system.includes("Search query generator")) {
      return { text: JSON.stringify({ query: "TypeScript tutorial" }) };
    }

    if (system.includes("Video relevance judge")) {
      return {
        text: JSON.stringify({
          chosen: "Mock Video",
          videoId: "abc123",
          startTime: 60,
          endTime: 300,
          adequate: true,
        }),
      };
    }

    if (system.includes("quality evaluator")) {
      return {
        text: JSON.stringify({
          thought: "Depth matches level, coverage acceptable.",
          approved: true,
          issues: [],
          action: "approve",
          chaptersToFix: [],
          feedback: "Blueprint looks good.",
        }),
      };
    }

    return { text: JSON.stringify({ text: "ok" }) };
  }
}

// ── Mock IO ───────────────────────────────────────────────────────

const userInputs = ["I know basic syntax", "practice please"];
let inputIndex = 0;
const outputLines: string[] = [];

const mockIO: AgentIO = {
  async getUserInput(prompt: string): Promise<string> {
    outputLines.push(`[PROMPT] ${prompt}`);
    return userInputs[inputIndex++] ?? "";
  },
  output(text: string): void {
    outputLines.push(text);
  },
};

// ── Mock Factory ──────────────────────────────────────────────────

class MockFactory extends ProviderFactory {
  private mock = new MockProvider();
  constructor() { super(); }
  forStep(_step: any) { return this.mock; }
}

// ── Mock Search ───────────────────────────────────────────────────

async function mockSearch() {
  return [
    {
      videoId: "abc123",
      title: "Mock Tutorial",
      description: "0:00 Intro\n1:00 Main content\n5:00 Summary",
      channelTitle: "MockChannel",
    },
  ];
}

// ── Run ───────────────────────────────────────────────────────────

(async () => {
  const state = createInitialState("TypeScript");
  const loop = new AgentLoop(state, new MockFactory(), mockIO, "", mockSearch, "");

  const finalState = await loop.run();

  console.log("=== Agent Loop Simulation ===");
  outputLines.forEach((l) => console.log(l));

  console.log("\n=== Final State ===");
  console.log(JSON.stringify(finalState, null, 2));

  const pass =
    finalState.planning.currentStep === "done" &&
    finalState.profile.level === "some" &&
    finalState.profile.preference === "practice-first" &&
    finalState.content.lecture.length === 3 &&
    finalState.control.degraded.length === 0; // no YouTube key → but adequate=true from mock

  console.log(pass ? "\nPASS" : "\nFAIL");
  process.exit(pass ? 0 : 1);
})();
