import * as readline from "readline";
import chalk from "chalk";
import ora, { Ora } from "ora";
import { AgentIO } from "./agent/loop";

// ── Helpers ───────────────────────────────────────────────────────

function progressBar(current: number, total: number, width = 12): string {
  const filled = Math.round((current / total) * width);
  return chalk.cyan("█".repeat(filled)) + chalk.gray("░".repeat(width - filled));
}

function pct(current: number, total: number): string {
  return chalk.dim(`${Math.round((current / total) * 100)}%`);
}

// ── RichIO ────────────────────────────────────────────────────────

export class RichIO implements AgentIO {
  private rl: readline.Interface;
  private spinner: Ora | null = null;
  private isTTY: boolean;

  constructor(rl: readline.Interface) {
    this.rl = rl;
    this.isTTY = process.stdout.isTTY ?? false;
  }

  async getUserInput(prompt: string): Promise<string> {
    this.stopSpinner();
    return new Promise((resolve) => {
      process.stdout.write(`\n${chalk.bold(prompt)}\n`);
      this.rl.question(`${chalk.cyan("❯")} `, (answer) => resolve(answer.trim()));
    });
  }

  output(text: string): void {
    this.stopSpinner();
    console.log(this.format(text));
  }

  startSpinner(message: string): void {
    if (!this.isTTY) return;
    this.spinner = ora({ text: chalk.dim(message), spinner: "dots" }).start();
  }

  stopSpinner(ok = true): void {
    if (!this.spinner) return;
    if (ok) {
      this.spinner.stop();
    } else {
      this.spinner.fail();
    }
    this.spinner = null;
  }

  setProgress(current: number, total: number, label: string): void {
    this.stopSpinner();
    const bar = progressBar(current, total);
    const num = chalk.dim(`[${current} / ${total}]`);
    const title = chalk.white(label);
    console.log(`  ${num}  ${bar}  ${pct(current, total)}  ${title}`);
  }

  // ── Text formatter ────────────────────────────────────────────────

  private format(text: string): string {
    // Step header
    if (text.startsWith("[step:")) {
      const match = text.match(/\[step:\s*(\w+)\]\s*\[model:\s*([^\]]+)\]/);
      if (match) {
        const step = match[1];
        const model = match[2];
        return (
          "\n" +
          chalk.bold.blue(`◆ ${step.padEnd(10)}`) +
          chalk.dim(`[${model}]`)
        );
      }
      return chalk.bold.blue(text);
    }

    // Thought
    if (text.includes("💭")) return chalk.dim(text);

    // Reflect output
    if (text.startsWith("[reflect]")) {
      const content = text.replace("[reflect]", "").trim();
      if (content.toLowerCase().includes("approve") || content.toLowerCase().includes("good") || content.toLowerCase().includes("accept")) {
        return chalk.green(`  ✓  ${content}`);
      }
      if (content.toLowerCase().includes("repair") || content.toLowerCase().includes("regenerate")) {
        return chalk.yellow(`  ↺  ${content}`);
      }
      return chalk.cyan(`  ✦  ${content}`);
    }

    // Reflect issues
    if (text.trim().startsWith("•")) return chalk.yellow(text);

    // RAG / search success
    if (text.includes("[rag]") || (text.includes("[search]") && !text.includes("error"))) {
      return chalk.green(text);
    }

    // Search error
    if (text.includes("[search error]")) return chalk.red(text);

    // Degraded warning
    if (text.includes("degraded") || text.includes("no adequate video")) {
      return chalk.yellow(text);
    }

    // Max retries / level unclear
    if (text.includes("retries reached") || text.includes("assuming beginner")) {
      return chalk.yellow(`  ⚠  ${text.replace(/^\s*\(?|\)?\s*$/, "").trim()}`);
    }

    // Blueprint output (synthesize)
    if (text.startsWith("# ")) {
      return chalk.bold.white("\n" + "─".repeat(50) + "\n" + text);
    }
    if (text.startsWith("## ") || text.startsWith("### ")) {
      return chalk.bold.cyan(text);
    }
    if (text.startsWith("🎬")) return chalk.blue(text);
    if (text.startsWith("_(") || text.includes("未找到")) return chalk.gray(text);

    // Query info
    if (text.includes("[4a query]")) return chalk.dim(text);

    return text;
  }
}
