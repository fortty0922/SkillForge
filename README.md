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
    S6 --> O6{approved?}
    O6 -- "否，retries ＜ 1" --> D6["注入 feedback\n重置內容"]
    D6 --> S2
    O6 -- 是 --> End([fa:fa-book 學習藍圖])

    classDef step fill:#4A90D9,stroke:#2C6FAC,color:#fff,rx:8
    classDef obs  fill:#F5A623,stroke:#C47D0E,color:#fff
    classDef degrade fill:#E74C3C,stroke:#C0392B,color:#fff
    classDef io fill:#27AE60,stroke:#1E8449,color:#fff
    class S1,S2,S3,S4,S5,S6 step
    class O1,O2,O3,O6 obs
    class D1,D3,D6 degrade
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
```

> **沒有 Gemini Key？** Agent 會自動 fallback 到 Ollama 跑所有步驟。  
> **沒有 YouTube Key？** 影片掛載步驟會跳過，輸出仍含完整講義。

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

### 執行流程範例

```
[step: assess]    [model: ollama/llama3]
Tell me about your experience with "TypeScript".
> I know JavaScript but never used TypeScript

[step: generate]  [model: gemini/gemini-1.5-flash]

[step: choose]    [model: ollama/llama3]
Lecture is ready! Do you prefer concept-first or practice-first?
> practice-first

[step: attach]    [model: gemini/gemini-1.5-flash]
  attaching video for: "Type Annotations"
  [4a query] "TypeScript Type Annotations tutorial"
  [search] 5 result(s) from YouTube      ← 第一次：打 API 並寫入本地庫

  attaching video for: "Interfaces"
  [4a query] "TypeScript Interfaces tutorial"
  [rag] 3 local result(s)                ← 第二次起：本地庫命中，不耗配額
  ...

[step: synthesize] [model: gemini/gemini-1.5-flash]
# Learning Blueprint: TypeScript
...

[step: reflect]   [model: gemini/gemini-1.5-flash]
[reflect] Blueprint looks good for a "some" level learner.
                                   ← approved → done
                                   ← 或 regenerate → 退回 generate 重做
```

---

## 開發指令

```bash
npm run dev         # ts-node 直接執行
npm run build       # 編譯到 dist/
npm run test        # 跑模擬測試（不需 API Key）
```

### 模擬測試

`src/test/agentLoop.test.ts` 使用 Mock Provider 和 Mock Search Function，不需要任何 API Key 即可跑完整的 6 步 ReAct 迴圈（含 reflect）驗證。

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
