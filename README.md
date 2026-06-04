# SkillForge Agent

個人化技能學習導航系統。使用者說出想學的技能，Agent 評估程度、生成個人化講義，並掛載對應的 YouTube 影片片段（含時間戳），輸出完整學習藍圖。

---

## 架構概覽

採 **Generate-then-Retrieve** 架構，核心框架為 **ReAct（Reasoning and Acting）**。

### 主流程圖

```mermaid
flowchart TD
    Start([使用者輸入技能]) --> S1

    subgraph S1["Step 1　程度評估　Ollama"]
        A1[詢問學習背景] --> A2[LLM 判斷程度]
        A2 --> OBS1{Obs1\nneedMoreProbing?}
        OBS1 -- "是，retries < 2" --> A1
        OBS1 -- "是，retries ≥ 2" --> A3[降級 level = none]
        OBS1 -- 否 --> A4[level 確定]
    end

    A3 & A4 --> S2

    subgraph S2["Step 2　講義生成　Gemini"]
        B1[依 skill / level / preference\n生成 4–6 章講義]
    end

    S2 --> S3

    subgraph S3["Step 3　方向選擇　Ollama"]
        C1[詢問學習風格] --> C2[LLM 解析偏好]
        C2 --> OBS2{Obs2\npreference 明確?}
        OBS2 -- 否 --> C1
        OBS2 -- 是 --> C3[preference 確定]
    end

    C3 --> S4

    subgraph S4["Step 4　影片掛載　Gemini + YouTube API"]
        D0{還有未處理章節?}
        D0 -- 是 --> D1
        D1["4a　LLM 生成搜尋詞\n[search query]"] --> D2{candidateCache\n命中?}
        D2 -- 是 --> D4
        D2 -- 否 --> D3[YouTube Search API]
        D3 --> D4["4b　LLM 判斷相關性\n[adequate?]"]
        D4 --> OBS3{Obs3\nadequate?}
        OBS3 -- "否，retries < 2" --> D5[清除 cache\n重搜]
        D5 --> D1
        OBS3 -- "否，retries ≥ 2" --> D6[degraded 標記]
        OBS3 -- 是 --> D7[寫入 videoMap]
        D6 & D7 --> D0
        D0 -- 全部完成 --> S5
    end

    subgraph S5["Step 5　整合輸出"]
        E1[合併 lecture + videoMap\n標註 degraded 章節]
    end

    S5 --> End([學習藍圖\n講義 + 影片時間戳])
```

### 三層架構

```mermaid
flowchart LR
    subgraph L1["第一層　Agent 核心"]
        Core["while loop + switch\n依 currentStep 決策\n唯一協調者，不碰網路"]
    end

    subgraph L2["第二層　Provider 抽象層"]
        Factory["ProviderFactory\nstep → model 派工表"]
        Ollama["OllamaProvider\n/v1/chat/completions"]
        Gemini["GeminiProvider\ngenerateContent"]
        Parser["容錯 JSON Parser\n剝 markdown fence"]
        Factory --> Ollama & Gemini
        Ollama & Gemini --> Parser
    end

    subgraph L3["第三層　Tool 層"]
        YT["YouTube Search\nData API v3\n100 units/次"]
        Meta["Metadata Parser\n解析 description\n章節時間戳\n純字串，無網路"]
    end

    Core -- "forStep(step)" --> Factory
    Core -- "searchYouTube()" --> YT
    Core -- "parseTimestamps()" --> Meta
```

---

## 專案結構

```
SkillForge/
├── prompts/               # 各步驟 system prompt（md 檔）
│   ├── base.md            # 共用身分宣告
│   ├── assess.md
│   ├── generate.md
│   ├── choose.md
│   ├── attach-4a.md
│   └── attach-4b.md
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
│       └── metadataParser.ts # 解析影片章節時間戳
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
[step: assess]
Tell me about your experience with "TypeScript".
> I know JavaScript but never used TypeScript

[step: generate]

[step: choose]
Lecture is ready! Do you prefer concept-first or practice-first?
> practice-first

[step: attach]
  attaching video for: "Type Annotations"
  attaching video for: "Interfaces"
  ...

[step: synthesize]
# Learning Blueprint: TypeScript
Level: some | Style: practice-first

## Type Annotations
...
🎬 [TypeScript Tutorial for Beginners](https://youtu.be/xxx?t=120) (2:00 – 8:30)
```

---

## 開發指令

```bash
npm run dev         # ts-node 直接執行
npm run build       # 編譯到 dist/
npm run test        # 跑模擬測試（不需 API Key）
```

### 模擬測試

`src/test/agentLoop.test.ts` 使用 Mock Provider 和 Mock Search Function，不需要任何 API Key 即可跑完整的 5 步 ReAct 迴圈驗證。

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

---

## YouTube 配額注意事項

YouTube Data API v3 預設每日 **10,000 units**，每次搜尋消耗 **100 units**。

Agent 內建兩道防護：
1. **`candidateCache`** — 相同搜尋詞直接複用，不重打 API
2. **`searchRetries` 上限** — 每章節最多重搜 2 次，超過即降級標記
