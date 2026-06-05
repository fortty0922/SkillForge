import { AgentLoop, AgentIO } from "../agent/loop";
import { createInitialState } from "../agent/state";
import { ProviderFactory } from "../provider/factory";
import { LLMMessage, LLMProvider, LLMResponse, VideoCandidate } from "../types";

// ── Helpers ───────────────────────────────────────────────────────

const CHAPTERS = [
  { id: "ch1", title: "Functions",   body: "Functions are reusable blocks." },
  { id: "ch2", title: "Classes",     body: "Classes enable OOP patterns."  },
  { id: "ch3", title: "Async/Await", body: "Async handles async operations." },
];

const MOCK_CANDIDATE: VideoCandidate = {
  videoId: "abc123",
  title: "Mock Tutorial",
  description: "0:00 Intro\n1:00 Main content\n5:00 Summary",
  channelTitle: "MockChannel",
};

async function mockSearch(): Promise<VideoCandidate[]> {
  return [MOCK_CANDIDATE];
}

function buildIO(): { io: AgentIO; lines: string[] } {
  const lines: string[] = [];
  const inputs = ["I know basic syntax", "practice please"];
  let idx = 0;
  return {
    lines,
    io: {
      async getUserInput(prompt: string): Promise<string> {
        lines.push(`[PROMPT] ${prompt}`);
        return inputs[idx++] ?? "";
      },
      output(text: string): void { lines.push(text); },
    },
  };
}

class MockFactory extends ProviderFactory {
  constructor(private mock: LLMProvider) { super(); }
  forStep(_step: any) { return this.mock; }
}

// ── StatefulMockProvider ──────────────────────────────────────────
// Returns configurable responses; counts per step key.

type ResponseFn = (callCount: number) => Record<string, unknown>;

class StatefulMockProvider implements LLMProvider {
  private counts: Record<string, number> = {};
  constructor(private handlers: Record<string, ResponseFn>) {}

  async chat(messages: LLMMessage[]): Promise<LLMResponse> {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const key = this.resolveKey(system);
    this.counts[key] = (this.counts[key] ?? 0) + 1;
    const fn = this.handlers[key] ?? (() => ({ text: "ok" }));
    return { text: JSON.stringify(fn(this.counts[key])) };
  }

  private resolveKey(system: string): string {
    if (system.includes("Skill level assessor")) return "assess";
    if (system.includes("Curriculum author"))    return "generate";
    if (system.includes("Learning path"))        return "choose";
    if (system.includes("Search query"))         return "attach4a";
    if (system.includes("Video relevance"))      return "attach4b";
    if (system.includes("quality evaluator"))    return "reflect";
    return "unknown";
  }
}

// ── Shared step responses ─────────────────────────────────────────

const assessOk = () => ({
  thought: "User knows basics.",
  level: "some", masteredConcepts: ["variables", "loops"],
  needMoreProbing: false, nextQuestion: "",
  language: "Traditional Chinese",
});

const generateOk = () => ({ chapters: CHAPTERS });

const chooseOk = () => ({
  options: [{ key: "practice-first", label: "Hands-on" }],
  recommendation: "Practice-first suits you.",
});

const attach4aOk = () => ({ query: "TypeScript tutorial" });

const attach4bAdequate = () => ({
  thought: "Good match.", chosenIndex: 0,
  videoId: "abc123", startTime: 60, endTime: 300, adequate: true,
});

const attach4bInadequate = () => ({
  thought: "No match.", chosenIndex: 0,
  videoId: "", startTime: 0, endTime: 0, adequate: false,
});

const reflectApprove = () => ({
  thought: "Looks good.", approved: true, issues: [],
  action: "approve", chaptersToFix: [], feedback: "Good blueprint.",
});

// ── Case A: Happy path ────────────────────────────────────────────

async function caseA(): Promise<boolean> {
  console.log("\n── Case A: Happy path ──");
  const { io, lines } = buildIO();
  const provider = new StatefulMockProvider({
    assess: assessOk,
    generate: generateOk,
    choose: chooseOk,
    attach4a: attach4aOk,
    attach4b: attach4bAdequate,
    reflect: reflectApprove,
  });
  const state = createInitialState("TypeScript");
  const loop = new AgentLoop(state, new MockFactory(provider), io, "", mockSearch, "");
  const s = await loop.run();

  const pass =
    s.planning.currentStep === "done" &&
    s.profile.level === "some" &&
    s.profile.preference === "practice-first" &&
    s.profile.language === "Traditional Chinese" &&
    s.planning.directionChosen === true &&
    s.planning.attachCursor === 3 &&
    s.planning.repairQueue.length === 0 &&
    s.content.lecture.length === 3 &&
    Object.keys(s.content.videoMap).length === 3 &&
    s.control.degraded.length === 0 &&
    s.control.reflectRetries === 0;

  console.log(pass ? "PASS" : "FAIL");
  if (!pass) lines.forEach((l) => console.log(l));
  return pass;
}

// ── Case B: Obs3 retry + degrade ─────────────────────────────────

async function caseB(): Promise<boolean> {
  console.log("\n── Case B: Obs3 retry + degrade ──");
  const { io } = buildIO();
  // ch1 always adequate; ch2 always inadequate → degrade after 2 retries
  const provider = new StatefulMockProvider({
    assess: assessOk,
    generate: generateOk,
    choose: chooseOk,
    attach4a: attach4aOk,
    attach4b: (count) => {
      // calls interleave across chapters; ch2 attempts = calls 2,4,6
      // simpler: track inadequate by always returning inadequate after call 1
      // ch1 gets call 1 → adequate; ch2 gets calls 2,3,4 → all inadequate
      return count === 1 ? attach4bAdequate() : attach4bInadequate();
    },
    reflect: reflectApprove,
  });
  const state = createInitialState("TypeScript");
  const loop = new AgentLoop(state, new MockFactory(provider), io, "", mockSearch, "");
  const s = await loop.run();

  const pass =
    s.planning.currentStep === "done" &&
    s.content.lecture.length === 3 &&
    s.control.degraded.length > 0 &&           // some chapters degraded
    s.control.reflectRetries === 0;             // reflect approved despite degraded

  console.log(pass ? "PASS" : `FAIL — degraded=${s.control.degraded}, step=${s.planning.currentStep}`);
  return pass;
}

// ── Case C: reflect repair → reattach ────────────────────────────

async function caseC(): Promise<boolean> {
  console.log("\n── Case C: reflect repair → reattach ──");
  const { io } = buildIO();
  let reflectCalls = 0;
  const provider = new StatefulMockProvider({
    assess: assessOk,
    generate: generateOk,
    choose: chooseOk,
    attach4a: attach4aOk,
    attach4b: attach4bAdequate,
    reflect: () => {
      reflectCalls++;
      if (reflectCalls === 1) {
        // First reflect: request repair of ch1
        return {
          thought: "ch1 timestamp invalid.", approved: false,
          issues: ["ch1 has no timestamp"],
          action: "repair",
          chaptersToFix: [{ id: "ch1", type: "reattach", reason: "timestamp=0" }],
          feedback: "Retry ch1 with better query.",
        };
      }
      // Second reflect: approve
      return reflectApprove();
    },
  });
  const state = createInitialState("TypeScript");
  const loop = new AgentLoop(state, new MockFactory(provider), io, "", mockSearch, "");
  const s = await loop.run();

  const pass =
    s.planning.currentStep === "done" &&
    s.control.reflectRetries === 1 &&
    s.planning.repairQueue.length === 0 &&   // cleared after repair
    s.content.lecture.length === 3 &&
    s.control.degraded.length === 0;

  console.log(pass ? "PASS" : `FAIL — step=${s.planning.currentStep}, reflectRetries=${s.control.reflectRetries}, repairQueue=${JSON.stringify(s.planning.repairQueue)}`);
  return pass;
}

// ── Run all ───────────────────────────────────────────────────────

(async () => {
  const a = await caseA();
  const b = await caseB();
  const c = await caseC();
  const results = [a, b, c];
  const allPass = results.every(Boolean);
  console.log(`\n${"─".repeat(40)}`);
  console.log(allPass ? "ALL PASS" : `FAILED: ${results.filter((r) => !r).length} case(s)`);
  process.exit(allPass ? 0 : 1);
})();
