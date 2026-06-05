import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { createInitialState } from "./agent/state";
import { AgentLoop, AgentIO } from "./agent/loop";
import { ProviderFactory, GEMINI_ONLY_POLICY } from "./provider/factory";
import { saveMarkdown, savePdf } from "./exporter";

// ── Config from environment ───────────────────────────────────────

const config = {
  ollamaBaseUrl:   process.env.OLLAMA_BASE_URL    ?? "http://localhost:11434",
  ollamaModel:     process.env.OLLAMA_MODEL       ?? "llama3",
  ollamaTimeoutMs: process.env.OLLAMA_TIMEOUT_MS  ? Number(process.env.OLLAMA_TIMEOUT_MS) : undefined,
  geminiApiKey:    process.env.GEMINI_API_KEY     ?? "",
  geminiModel:     process.env.GEMINI_MODEL       ?? "gemini-1.5-flash",
};

const youtubeApiKey = process.env.YOUTUBE_API_KEY ?? "";

// ── CLI IO ────────────────────────────────────────────────────────

const rl = readline.createInterface({
  input:  process.stdin,
  output: process.stdout,
});

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`\n${prompt}\n> `, (answer) => resolve(answer.trim()));
  });
}

const io: AgentIO = {
  getUserInput: ask,
  output(text: string) {
    console.log(text);
  },
};

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const skillArg = process.argv[2];
  const skill = skillArg ?? (await ask("What skill do you want to learn?"));

  if (!skill) {
    console.error("No skill provided. Usage: ts-node src/index.ts <skill>");
    process.exit(1);
  }

  console.log(`\nStarting SkillForge for: "${skill}"\n`);

  const ragStorePath = path.resolve("data/candidates.json");
  fs.mkdirSync(path.dirname(ragStorePath), { recursive: true });

  const geminiOnly = process.env.GEMINI_ONLY === "true" && !!config.geminiApiKey;
  const policy  = geminiOnly ? GEMINI_ONLY_POLICY : undefined;
  if (geminiOnly) console.log("(Gemini-only mode enabled)\n");

  const factory = new ProviderFactory(config, policy ?? {});
  const state   = createInitialState(skill);
  const loop    = new AgentLoop(state, factory, io, youtubeApiKey, undefined, ragStorePath);

  try {
    const finalState = await loop.run();

    const saveChoice = (await ask("Save output as file? (y/n)")).toLowerCase();
    if (saveChoice === "y" || saveChoice === "yes") {
      const fmt = await ask("Format:\n1. Markdown (.md)\n2. PDF (.pdf)");
      const outputDir = path.resolve("output");
      fs.mkdirSync(outputDir, { recursive: true });

      let filePath: string;
      if (fmt.trim() === "2") {
        filePath = await savePdf(finalState, outputDir);
      } else {
        filePath = await saveMarkdown(finalState, outputDir);
      }
      console.log(`\nSaved: ${filePath}`);
    }
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  rl.close();
  process.exit(1);
});
