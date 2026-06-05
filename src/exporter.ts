import * as fs from "fs";
import * as path from "path";
import PDFDocument from "pdfkit";
import { AgentState } from "./types";

// ── Helpers ───────────────────────────────────────────────────────

function isoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function safeFilename(skill: string): string {
  return skill.replace(/[^\w一-鿿぀-ヿ\s-]/g, "").trim().replace(/\s+/g, "_");
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ── Markdown document builder ──────────────────────────────────────

export function buildDocument(state: AgentState): string {
  const { skill, level, preference, masteredConcepts, language } = state.profile;
  const { lecture, videoMap } = state.content;
  const { degraded } = state.control;
  const date = isoDate();

  const levelLabel = language === "Traditional Chinese" || language === "Simplified Chinese"
    ? (level === "none" ? "零基礎" : level === "some" ? "有基礎" : "進階")
    : (level ?? "unknown");

  const prefLabel = language === "Traditional Chinese" || language === "Simplified Chinese"
    ? (preference === "concept-first" ? "概念優先" : preference === "practice-first" ? "實作優先" : "未選擇")
    : (preference ?? "not chosen");

  const lines: string[] = [];

  // ── Header ──
  lines.push(`# 學習藍圖 — ${skill}`);
  lines.push(`> 生成日期：${date}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // ── Assessment summary ──
  lines.push("## 學習者評估摘要");
  lines.push("");
  lines.push("| 欄位 | 值 |");
  lines.push("|------|---|");
  lines.push(`| 程度 | ${levelLabel} |`);
  lines.push(`| 學習風格 | ${prefLabel} |`);
  lines.push(`| 已掌握概念 | ${masteredConcepts.length ? masteredConcepts.join("、") : "—"} |`);
  lines.push("");
  lines.push("### 程度說明");
  lines.push("- **零基礎**：從零開始，課程涵蓋所有基礎");
  lines.push("- **有基礎**：有基礎，課程跳過已知概念，聚焦進階");
  lines.push("- **進階**：深度使用者，課程著重內部原理與邊界情況");
  lines.push("");
  lines.push("---");
  lines.push("");

  // ── Table of contents ──
  lines.push("## 課程目錄");
  lines.push("");
  lecture.forEach((ch, i) => {
    lines.push(`${i + 1}. ${ch.title}`);
  });
  lines.push("");
  lines.push("---");
  lines.push("");

  // ── Chapters ──
  lines.push("## 課程內容");
  lines.push("");
  for (const ch of lecture) {
    lines.push(`### ${ch.title}`);
    lines.push("");
    lines.push(ch.body);
    lines.push("");

    const video = videoMap[ch.id];
    if (video) {
      const ts = video.startTime > 0
        ? ` (${formatTime(video.startTime)} – ${formatTime(video.endTime)})`
        : "";
      const url = `https://youtu.be/${video.videoId}${video.startTime > 0 ? `?t=${video.startTime}` : ""}`;
      lines.push(`🎬 [${video.title}](${url})${ts}`);
    } else if (degraded.includes(ch.id)) {
      lines.push("_（未找到合適影片）_");
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");

  // ── Video coverage table ──
  lines.push("## 影片覆蓋摘要");
  lines.push("");
  lines.push("| 章節 | 影片狀態 |");
  lines.push("|------|---------|");
  for (const ch of lecture) {
    const video = videoMap[ch.id];
    if (video) {
      const url = `https://youtu.be/${video.videoId}${video.startTime > 0 ? `?t=${video.startTime}` : ""}`;
      lines.push(`| ${ch.title} | [${video.title}](${url}) |`);
    } else {
      lines.push(`| ${ch.title} | ❌ 未找到影片 |`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("*由 SkillForge Agent 自動生成*");

  return lines.join("\n");
}

// ── Save as Markdown ───────────────────────────────────────────────

export async function saveMarkdown(state: AgentState, outputDir: string): Promise<string> {
  const doc = buildDocument(state);
  const filename = `${safeFilename(state.profile.skill)}_${isoDate()}.md`;
  const filePath = path.join(outputDir, filename);
  fs.writeFileSync(filePath, doc, "utf-8");
  return filePath;
}

// ── Save as PDF ────────────────────────────────────────────────────

const CJK_FONT_CANDIDATES = [
  "/System/Library/Fonts/PingFang.ttc",           // macOS PingFang
  "/System/Library/Fonts/STHeiti Light.ttc",      // macOS Heiti
  "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc", // macOS Hiragino
];

function findCjkFont(): string | null {
  return CJK_FONT_CANDIDATES.find((f) => fs.existsSync(f)) ?? null;
}

export async function savePdf(state: AgentState, outputDir: string): Promise<string> {
  const { skill, level, preference, masteredConcepts } = state.profile;
  const { lecture, videoMap } = state.content;
  const { degraded } = state.control;

  const filename = `${safeFilename(skill)}_${isoDate()}.pdf`;
  const filePath = path.join(outputDir, filename);
  const writeStream = fs.createWriteStream(filePath);

  const cjkFont = findCjkFont();
  const doc = new PDFDocument({ margin: 60, size: "A4" });
  doc.pipe(writeStream);

  const registerFont = (name: string) => {
    if (cjkFont) doc.registerFont(name, cjkFont);
  };
  registerFont("CJK");
  const font = (size: number) => cjkFont ? doc.font("CJK").fontSize(size) : doc.font("Helvetica").fontSize(size);

  // Title
  font(22).text(`學習藍圖 — ${skill}`, { align: "center" });
  doc.fontSize(10).fillColor("gray").text(`生成日期：${isoDate()}`, { align: "center" });
  doc.fillColor("black").moveDown(1.5);
  doc.moveTo(60, doc.y).lineTo(535, doc.y).stroke();
  doc.moveDown(1);

  // Assessment summary
  font(15).text("學習者評估摘要");
  doc.moveDown(0.5);
  font(11)
    .text(`程度：${level ?? "—"}`)
    .text(`學習風格：${preference ?? "—"}`)
    .text(`已掌握概念：${masteredConcepts.length ? masteredConcepts.join("、") : "—"}`);
  doc.moveDown(1);

  // TOC
  doc.moveTo(60, doc.y).lineTo(535, doc.y).stroke().moveDown(0.5);
  font(15).text("課程目錄");
  doc.moveDown(0.5);
  lecture.forEach((ch, i) => {
    font(11).text(`${i + 1}. ${ch.title}`);
  });
  doc.moveDown(1);

  // Chapters
  doc.moveTo(60, doc.y).lineTo(535, doc.y).stroke().moveDown(0.5);
  font(15).text("課程內容");
  doc.moveDown(0.5);

  for (const ch of lecture) {
    font(13).text(ch.title);
    doc.moveDown(0.3);
    font(11).text(ch.body, { align: "justify" });
    doc.moveDown(0.3);

    const video = videoMap[ch.id];
    if (video) {
      const url = `https://youtu.be/${video.videoId}${video.startTime > 0 ? `?t=${video.startTime}` : ""}`;
      const ts = video.startTime > 0 ? ` (${formatTime(video.startTime)}–${formatTime(video.endTime)})` : "";
      doc.fillColor("blue").text(`🎬 ${video.title}${ts}`, { link: url, underline: true });
      doc.fillColor("black");
    } else if (degraded.includes(ch.id)) {
      doc.fillColor("gray").text("（未找到合適影片）");
      doc.fillColor("black");
    }
    doc.moveDown(0.8);
  }

  // Footer
  doc.moveTo(60, doc.y).lineTo(535, doc.y).stroke().moveDown(0.5);
  doc.fontSize(9).fillColor("gray").text("由 SkillForge Agent 自動生成", { align: "center" });

  doc.end();

  return new Promise((resolve, reject) => {
    writeStream.on("finish", () => resolve(filePath));
    writeStream.on("error", reject);
  });
}
