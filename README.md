# SkillForge Agent

個人化技能學習導航系統。使用者說出想學的技能，Agent 評估程度、生成個人化講義，並掛載對應的 YouTube 影片片段（含時間戳），輸出完整學習藍圖。

---

## 架構概覽

採 **Generate-then-Retrieve** 架構，核心框架為 **ReAct（Reasoning and Acting）**。

### ReAct 主流程

```mermaid
flowchart TD
    Start([fa:fa-user 輸入技能]) --> S1

    S1(["Step 1　程度評估\nOllama"])
    S1 --> O1{Obs 1\nneedMoreProbing?}
    O1 -- "是，retries ＜ 2" --> S1
    O1 -- "retries ≥ 2" --> D1["⚠ 降級 level = none"]
    O1 -- 否 --> S2
    D1 --> S2

    S2(["Step 2　講義生成\nGemini"])
    S2 --> S3

    S3(["Step 3　方向選擇\nOllama"])
    S3 --> O2{Obs 2\npreference 明確?}
    O2 -- 否 --> S3
    O2 -- 是 --> S4

    S4(["Step 4　影片掛載\nGemini + YouTube"])
    S4 --> O3{Obs 3\nadequate?}
    O3 -- "否，retries ＜ 2" --> S4
    O3 -- "retries ≥ 2" --> D3["⚠ degraded 標記"]
    O3 -- 是 --> S5
    D3 --> S5

    S5(["Step 5　整合輸出"])
    S5 --> S6

    S6(["Step 6　品質評估\nGemini"])
    S6 --> O6{action?}
    O6 -- approve --> End([fa:fa-book 學習藍圖])
    O6 -- "repair\nretries ＜ 1" --> D6r["指定章節\n修復佇列"]
    D6r -- "type=reattach" --> S4
    D6r -- "type=rewrite" --> S2
    O6 -- "regenerate\nretries ＜ 1" --> D6["注入 feedback\n全部重置"]
    D6 --> S2

    classDef step fill:#4A90D9,stroke:#2C6FAC,color:#fff,rx:8
    classDef obs  fill:#F5A623,stroke:#C47D0E,color:#fff
    classDef degrade fill:#E74C3C,stroke:#C0392B,color:#fff
    classDef io fill:#27AE60,stroke:#1E8449,color:#fff
    class S1,S2,S3,S4,S5,S6 step
    class O1,O2,O3,O6 obs
    class D1,D3,D6,D6r degrade
    class Start,End io
```

### Step 4 影片掛載細節

```mermaid
flowchart TD
    In([下一章節]) --> A

    A["4a　LLM 生成搜尋詞"]
    A --> C1{Session\nCache?}

    C1 -- 命中 --> Judge
    C1 -- 未命中 --> C2{Local\nRAG Store?}

    C2 -- "命中 → rag" --> Judge
    C2 -- 未命中 --> YT["YouTube Data API v3"]
    YT --> Save["寫入 candidates.json"]
    Save --> Judge

    Judge["4b　LLM 判斷相關性"]
    Judge --> Adeq{adequate?}

    Adeq -- "否，retries ＜ 2" --> Clear["清除 cache"] --> A
    Adeq -- "retries ≥ 2" --> Deg(["⚠ degraded"])
    Adeq -- 是 --> VM(["✓ videoMap 更新"])

    classDef step  fill:#4A90D9,stroke:#2C6FAC,color:#fff
    classDef cache fill:#8E44AD,stroke:#6C3483,color:#fff
    classDef ext   fill:#16A085,stroke:#0E6655,color:#fff
    classDef ok    fill:#27AE60,stroke:#1E8449,color:#fff
    classDef warn  fill:#E74C3C,stroke:#C0392B,color:#fff
    class A,Judge step
    class C1,C2,Adeq cache
    class YT,Save ext
    class VM,In ok
    class Deg,Clear warn
```

### 三層架構

```mermaid
flowchart TD
    subgraph Core["第一層　Agent 核心"]
        Loop["AgentLoop\nwhile loop + switch\ncurrentStep 為唯一真相來源"]
    end

    subgraph Provider["第二層　Provider 抽象層"]
        Factory["ProviderFactory\nstep → model 派工"]
        Ollama["Ollama\nllama3"]
        Gemini["Gemini\ngemini-1.5-flash"]
        Factory --> Ollama
        Factory --> Gemini
    end

    subgraph Tools["第三層　Tool 層"]
        YT["YouTube Search\nData API v3"]
        Meta["Metadata Parser\n時間戳解析"]
        RAG["RAG Store\ncandidates.json"]
        YT --> RAG
    end

    Loop -->|"forStep(step)"| Factory
    Loop -->|"searchLocal()"| RAG
    Loop -->|"searchYouTube()"| YT
    Loop -->|"parseTimestamps()"| Meta

    classDef layer fill:#2C3E50,stroke:#1A252F,color:#fff
    classDef node  fill:#34495E,stroke:#2C3E50,color:#fff
    class Loop,Factory,Ollama,Gemini,YT,Meta,RAG node
```

---

## 專案結構

```
SkillForge/
├── prompts/               # 各步驟 system prompt（md 檔）
│   ├── base.md            # 共用身分宣告 + 語言規則
│   ├── assess.md
│   ├── generate.md
│   ├── choose.md
│   ├── attach-4a.md
│   ├── attach-4b.md
│   └── reflect.md         # 品質評估：深度匹配、影片覆蓋、時間戳有效性
├── src/
│   ├── index.ts           # CLI 入口
│   ├── types.ts           # 所有型別定義
│   ├── exporter.ts        # 儲存學習藍圖（.md / .pdf）
│   ├── cli.ts             # RichIO：顏色、spinner、進度條
│   ├── agent/
│   │   ├── state.ts       # createInitialState()
│   │   ├── prompts.ts     # 讀取 md 檔，組合 LLMMessage[]
│   │   └── loop.ts        # AgentLoop（ReAct 主迴圈）
│   ├── provider/
│   │   ├── parseResponse.ts  # 容錯 JSON parser
│   │   ├── ollama.ts
│   │   ├── gemini.ts
│   │   └── factory.ts        # step → model 派工表
│   └── tools/
│       ├── youtubeSearch.ts  # YouTube Data API v3
│       ├── metadataParser.ts # 解析影片章節時間戳
│       └── ragStore.ts       # 本地 RAG：持久化 + 關鍵字搜尋
├── data/                  # 執行時自動建立，gitignored
│   └── candidates.json    # 跨 session 影片資源庫
├── output/                # 儲存的學習藍圖（gitignored）
├── .env.example
├── package.json
└── tsconfig.json
```

---

## 環境設定

### 需求

- Node.js 18+
- （可選）本地 [Ollama](https://ollama.com/) — assess / choose 步驟
- Google Gemini API Key — generate / attach 步驟
- YouTube Data API v3 Key — 影片搜尋

### 安裝

```bash
npm install
```

### 設定 API Keys

```bash
cp .env.example .env
```

編輯 `.env`：

```env
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3

GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-1.5-flash

YOUTUBE_API_KEY=your_youtube_api_key_here

# 選填
GEMINI_ONLY=false          # true → 全程使用 Gemini，忽略 Ollama
OLLAMA_TIMEOUT_MS=300000   # 預設 300s，大模型可調高
```

> **沒有 Gemini Key？** Agent 會自動 fallback 到 Ollama 跑所有步驟。  
> **沒有 YouTube Key？** 影片掛載步驟會跳過，輸出仍含完整講義。  
> **`GEMINI_ONLY=true`** 設定後，所有 6 個步驟全走 Gemini，適合 Ollama 較慢或不可用時。

---

## 使用方式

```bash
# 直接指定技能
npx ts-node src/index.ts "TypeScript"

# 互動式輸入
npx ts-node src/index.ts

# 編譯後執行
npm run build
npm start "TypeScript"
```

### 執行流程範例（含視覺化輸出）

```
🎯  SkillForge — TypeScript

◆ assess     [model: ollama/qwen3:9b]       ← 藍色步驟標頭
Tell me about your experience with "TypeScript".
❯ 我完全沒有 TypeScript 經驗，但會寫 JavaScript
⠋ Evaluating...                             ← spinner（等待 LLM）
  💭 User has JS experience but zero TS — level=none.

◆ generate   [model: gemini/gemini-1.5-flash]
⠋ Generating lecture...

◆ choose     [model: ollama/qwen3:9b]
Lecture is ready! Do you prefer concept-first or practice-first?
❯ 我想先學概念
⠋ Analyzing preference...

◆ attach     [model: gemini/gemini-1.5-flash]
  [1 / 5]  ████████░░░░  60%  TypeScript 簡介    ← 進度條
  ⠋ Generating query...
  [4a query] "TypeScript 簡介 教學"
  [search] 5 result(s) from YouTube             ← 綠色，第一次打 API

  [2 / 5]  ████████████  80%  型別系統基礎
  [rag] 3 local result(s)                       ← 綠色，本地庫命中

◆ synthesize [model: gemini/gemini-1.5-flash]
──────────────────────────────────────────────────
# 學習藍圖：TypeScript
...

◆ reflect    [model: gemini/gemini-1.5-flash]
⠋ Evaluating blueprint quality...
  💭 深度符合零基礎程度，所有章節皆有影片。
  ✓  藍圖品質良好。                             ← 綠色 approve

✓  Complete!

Save output as file? (y/n)
❯ y

Format:
  1. Markdown (.md)
  2. PDF (.pdf)
❯ 2

  Saved: ./output/TypeScript_2026-06-05.pdf
```

---

## 儲存輸出

Agent 完成後會詢問是否將學習藍圖儲存為檔案：

| 格式 | 說明 |
|------|------|
| `.md` | Markdown 純文字，可用任何編輯器開啟 |
| `.pdf` | 使用系統 CJK 字體（macOS: PingFang / Windows: 微軟正黑體）渲染 |

輸出路徑：`output/{技能名稱}_{日期}.{副檔名}`（目錄自動建立，已 gitignore）

### 文件結構（固定模板）

```
# 學習藍圖 — {技能}

## 學習者評估摘要    ← 程度 / 學習風格 / 已掌握概念 + 程度說明
## 課程目錄          ← 章節編號列表
## 課程內容          ← 每章標題 + 內容 + 🎬 影片連結（含時間戳）
## 影片覆蓋摘要      ← 每章的影片狀態表格
```

---

## 開發指令

```bash
npm run dev         # ts-node 直接執行
npm run build       # 編譯到 dist/
npm run test        # 跑模擬測試（不需 API Key）
```

### 模擬測試

`src/test/agentLoop.test.ts` 使用 `StatefulMockProvider`（支援依呼叫次數回傳不同值），涵蓋三條路徑：

| Case | 路徑 | 驗證重點 |
|------|------|---------|
| A | Happy path | `videoMap` 完整、`attachCursor`、`directionChosen` |
| B | Obs3 retry + degrade | `degraded[]` 非空、`searchRetries` 計數 |
| C | reflect repair → reattach | `reflectRetries=1`、`repairQueue` 清空 |

---

## 調整 Prompts

所有 system prompt 存放於 `prompts/` 目錄，直接編輯 md 檔即可，不需動程式碼。

支援 `{{placeholder}}` 語法動態注入 State 值：

| 檔案 | 可用變數 |
|------|---------|
| `assess.md` | `{{skill}}`, `{{knownConcepts}}` |
| `generate.md` | `{{skill}}`, `{{level}}`, `{{skipTopics}}`, `{{learningStyle}}` |
| `choose.md` | `{{skill}}`, `{{level}}` |
| `attach-4a.md` | — |
| `attach-4b.md` | — |
| `reflect.md` | — |

---

## YouTube 配額注意事項

YouTube Data API v3 預設每日 **10,000 units**，每次搜尋消耗 **100 units**。

Agent 內建三道防護：

| 層 | 機制 | 說明 |
|----|------|------|
| 1 | **Local RAG Store** | 跨 session 持久化，相同主題第二次起不打 API |
| 2 | **`candidateCache`** | session 內快取，同一 query 不重複呼叫 |
| 3 | **`searchRetries` 上限** | 每章節最多重搜 2 次，超過即降級標記 |

搜尋結果存於 `data/candidates.json`（自動建立，已 gitignore）。
