import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import chalk from "chalk";
import { createInitialState } from "./agent/state";
import { AgentLoop } from "./agent/loop";
import { ProviderFactory, GEMINI_ONLY_POLICY } from "./provider/factory";
import { saveMarkdown, savePdf } from "./exporter";
import { RichIO } from "./cli";

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

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const io = new RichIO(rl);

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const skillArg = process.argv[2];
  const skill = skillArg ?? (await io.getUserInput("What skill do you want to learn?"));

  if (!skill) {
    console.error(chalk.red("No skill provided. Usage: ts-node src/index.ts <skill>"));
    process.exit(1);
  }

  console.log(chalk.bold(`\n🎯  SkillForge — ${skill}\n`));

  const ragStorePath = path.resolve("data/candidates.json");
  fs.mkdirSync(path.dirname(ragStorePath), { recursive: true });

  const geminiOnly = process.env.GEMINI_ONLY === "true" && !!config.geminiApiKey;
  if (geminiOnly) console.log(chalk.dim("  (Gemini-only mode)\n"));

  const policy  = geminiOnly ? GEMINI_ONLY_POLICY : undefined;
  const factory = new ProviderFactory(config, policy ?? {});
  const state   = createInitialState(skill);
  const loop    = new AgentLoop(state, factory, io, youtubeApiKey, undefined, ragStorePath);

  try {
    const finalState = await loop.run();

    console.log("\n" + chalk.bold.green("✓  Complete!"));

    const saveChoice = (await io.getUserInput("Save output as file? (y/n)")).toLowerCase();
    if (saveChoice === "y" || saveChoice === "yes") {
      const fmt = await io.getUserInput("Format:\n  1. Markdown (.md)\n  2. PDF (.pdf)");
      const outputDir = path.resolve("output");
      fs.mkdirSync(outputDir, { recursive: true });

      let filePath: string;
      if (fmt.trim() === "2") {
        filePath = await savePdf(finalState, outputDir);
      } else {
        filePath = await saveMarkdown(finalState, outputDir);
      }
      console.log(chalk.green(`\n  Saved: ${chalk.underline(filePath)}`));
    }
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(chalk.red("Fatal:"), err);
  rl.close();
  process.exit(1);
});
