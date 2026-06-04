# CLAUDE.md — SkillForge Agent

本檔案供 AI 編碼工具(Claude Code 等)閱讀,說明本專案的架構與設計決策。
動手寫任何程式前,請先讀完並遵守本檔。**這些決策是刻意的取捨,不要自作主張改動。**

---

## 專案是什麼

SkillForge Agent:以單一 LLM Agent 為核心的個人化技能學習導航系統。
使用者說出想學的技能,Agent 評估其程度、生成個人化講義,再掛載對應的
YouTube 影片片段(含時間戳),輸出完整學習藍圖。

採 **Generate-then-Retrieve** 架構:先用 LLM 的參數記憶生成結構化講義,
再事後掛載影片。與傳統「先爬逐字稿再總結」方向相反,目的是把回應時間
壓到 3 秒內並降低外部 I/O 依賴。

核心框架:**ReAct(Reasoning and Acting)**,Thought → Action → Observation 迴圈。

---

## 技術選型(已定,勿改)

- 語言 / 執行環境:**TypeScript**
- 模型:**本地 Ollama** 與 **Google Gemini**,兩者可切換
- 影片來源:**YouTube Data API v3**
- 持久化:**JSON 檔**,**不是 SQLite**(理由見下)
- **不使用 LangChain / LangGraph 等 agent 框架**——本專案刻意自己寫迴圈,
  以保留對 ReAct 每一步的完全掌控與透明度

---

## 軟體架構:三層

控制流由上往下單向流動,只有 State 是被讀寫的共用資料。

### 第一層:Agent 核心(ReAct 迴圈)

- 純邏輯,**不直接碰網路**。
- 一個 `while` 迴圈 + `switch`,依 `state.planning.currentStep` 決定下一步。
- 是唯一的協調者:讀 State → 決定動作 → 呼叫下層 → 把結果寫回 State。
- 下層(Provider、Tool)都是被動被呼叫,**不主動做事**。守住這個紀律,
  否則邏輯會散到各處、難以 debug。

### 第二層:LLM Provider 抽象層

- 目的:把 Ollama 與 Gemini 的差異藏起來。對上提供統一介面
  (輸入訊息 + 可用工具 → 回傳文字或工具呼叫意圖)。
- Ollama 走 OpenAI 相容的 `/v1/chat/completions`;Gemini 走 `generateContent`。
- **內部統一用結構化 JSON 決策格式**。因為 Ollama 小模型的 native
  function calling 不穩,上層只認一種 JSON 格式;支援 native tool calling
  的 Gemini 由本層負責轉接。需要一個容錯 parser(模型偶爾多吐 markdown 圍欄)。

### 第三層:Tool 實作層

- **只放真正有外部呼叫的工具**,目前兩個:
  - `YouTube Search`:打 Data API v3。**會吃配額**(預設每日 10000 units,
    一次 search 吃 100 units)。
  - `Metadata Parser`:解析影片 description 裡創作者標註的時間戳(Chapters)。
    **純字串處理,不打網路。**
- **純 prompt 的步驟(程度評估、課程選擇)不放這裡**,它們活在 Agent 核心
  的 Thought 裡。把它們包成 Tool 反而難以說明 input/output schema,只會
  讓架構不必要地複雜。

---

## State(核心資料結構)

**原則:純資料、可序列化。** 只放會影響後續決策的東西,不要當 log 用。
裡面只有字串、數字、布林、陣列、巢狀物件——**沒有函式、沒有 class
instance、沒有 Date 物件**(時間用 ISO 字串或數字)。這樣 `JSON.stringify(state)`
隨時能存檔。

歷史對話(給 LLM 的 messages)**不放進 State**——那是原始對話流,與
「結構化決策依據」是兩回事。Provider 層需要時另外傳。

頂層結構(概念版):

```
state = {
  profile:  { skill, level, masteredConcepts, preference }
  planning: { currentStep, directionChosen, attachCursor }
  content:  { lecture[], videoMap{}, candidateCache{} }
  control:  { assessRetries, searchRetries{}, degraded[] }
}
```

### profile(使用者畫像,評估的產出)
- `skill`:技能主題,字串
- `level`:程度等級,固定列舉 `"none" | "some" | "advanced"`,初始 `null`。
  `null` 本身就是 Obs1 的判斷依據(尚未評估完)。**勿用自由文字。**
- `masteredConcepts`:已掌握概念,字串陣列
- `preference`:學習偏好 `"concept-first" | "practice-first" | null`,
  `null` 代表還沒選。課程方向就存在這裡,不要在別處重複。

### planning(規劃狀態)
- `currentStep`:列舉 `"assess" | "generate" | "choose" | "attach" | "synthesize" | "done"`。
  **這是迴圈的唯一真相來源(single source of truth)。** 每輪開頭讀它決定走哪,
  步驟成功才推進,回退時退回前一個值。
- `directionChosen`:布林,Obs2 判斷依據
- `attachCursor`:Step 3(attach)是逐章節跑 Search+Parser,此游標記錄目前
  處理到第幾章(章節 index 或 id)。支援續跑(掛到第 3 章關掉,回來從第 3 章繼續)。

### content(內容與影片,**鬆耦合**)
- `lecture`:講義,章節陣列。每章節 `{ id, title, body }`。
  **章節不含影片欄位**,純內容。
- `videoMap`:物件,key = 章節 `id`,value = 掛載的影片
  `{ videoId, title, startTime, endTime }`。
  Obs3 重搜某章影片時**只動 `videoMap[id]`,不碰 `lecture`**。
- `candidateCache`:搜尋快取。key = 搜尋詞,value = 該次 API 回來的候選影片陣列。
  重搜前先查快取,相同搜尋詞直接複用以**省 YouTube 配額**。
  (註:跨多次對話時此快取會長大,未來可考慮 LRU 上限;單次 demo 不必。)

### control(控制旗標,自己寫的防呆)
- `assessRetries`:單一數字,Obs1 用(評估是線性的)
- `searchRetries`:**map** `{ [chapterId]: number }`,**每章節各自計數**。
  某章搜不到不該拖累其他章。
- `degraded`:陣列或 map,記哪些章節已降級(搜不到、掛次優、或沒掛),
  Step 4 輸出時據此誠實標註。

---

## ReAct 迴圈:五步 + 三個回退點

```
Step 1 程度評估   (純 prompt,建議 Ollama)
   ↓
Obs 1  程度夠明確?否 → 追問(退回 Step 1)
   ↓
Step 2 講義生成   (參數記憶,建議 Gemini,不呼叫工具)
   ↓
Obs 2  課程方向選了?否 → 重提示(退回 Step 2 對話)
   ↓
Step 3 影片掛載   (逐章節:YouTube Search → Metadata Parser,建議 Gemini)
   ↓
Obs 3  影片品質夠?否 → 重搜(退回該章節的搜尋)
   ↓
Step 4 整合輸出   (講義 + 時間戳,用 id 把 lecture 與 videoMap 合起來)
```

**三個 Observation 是回退點,這是 ReAct 有別於單純 pipeline 的關鍵。**
它們不是線性流程,而是讓 Agent 具備反饋判斷能力。

### 回退必須設上限(自己寫沒有框架幫你擋)

- 每個回退點都要有 `maxRetries`(建議:Obs1 追問 ≤2、Obs3 重搜 ≤2)。
- **超過上限就降級,絕不空轉:**
  - Obs3 搜不到好影片 → 掛上次最好的、或誠實告訴使用者「這段沒找到合適影片」,
    並在 `control.degraded` 標記。
- Obs3 重搜最危險(會燒 YouTube 配額),重搜前**務必先查 `candidateCache`**。

---

## step → model 派工(policy 表)

不要在程式各處硬寫「這步用哪個模型」。集中成一張可整個覆寫的對應表,
放在 Provider 抽象層之上。預設建議:

| 步驟 | 預設模型 | 原因 |
|------|----------|------|
| 程度評估(assess) | Ollama | 多輪、容錯高、成本敏感 |
| 課程選擇(choose) | Ollama | 同上 |
| 講義生成(generate) | Gemini | 吃參數記憶與內容品質 |
| 影片掛載(attach) | Gemini | 吃 tool calling 穩定度 |

「可切換」= 這張表能一次覆寫(例如離線 demo 全切 Ollama)。
切換點集中在這張表 + Provider 抽象層,**不汙染 Agent 核心**。

---

## Prompt 設計(系統幾乎所有智能都在這裡)

本系統不是「一個 system prompt 用到底」,而是**每步一個 prompt**。
因為各步在做本質不同的事(提問者 / 作者 / 規劃者 / 搜尋者),角色與輸出
格式都不同。對應你文件 Profile Definition「角色依程度動態調整」的設計。

### 分兩層

- **base system prompt(共用,每步都帶)**:Agent 身分(個人化技能學習顧問)、
  整體目標、以及**統一的 JSON 輸出外框契約**——只輸出合法 JSON、不要 markdown
  圍欄、不要任何 JSON 以外的文字。Provider 層的容錯 parser 依此外框運作。
- **step prompt(各步覆蓋)**:該步的角色、任務、該步特有的 JSON 欄位。

實際餵給 LLM = `base + step prompt + 從 State 注入的動態脈絡`。

### Prompt registry

一張 `step → prompt template` 的對應表,與 `step → model` 表是**姊妹**:
registry 決定「給什麼指令」,派工表決定「用誰的腦」,兩者都靠 `currentStep`
查表,並排放在 Agent 核心裡。

**Prompt template 是靜態設定(寫死在程式或設定檔),不進 State。**
State 只放「填進 prompt 的動態值」。

### 各步 prompt 契約

輸出欄位刻意設計成**對齊 State 結構**,核心拿到 JSON 後幾乎能直接寫進 State,
中間不用轉換。

| 步驟 | 角色 | 從 State 注入 | 回傳 JSON 欄位 |
|------|------|---------------|----------------|
| assess | 探測程度的提問者 | `profile.skill`、已知 `masteredConcepts`、本輪回覆 | `{ level, masteredConcepts, needMoreProbing, nextQuestion }` |
| generate | 依程度寫講義的作者 | `profile.skill/level/masteredConcepts/preference` | `{ chapters: [{ id, title, body }] }` |
| choose | 提供方向選項的規劃者 | `lecture` 大綱(title)、`profile.level` | `{ options: [{ key, label }], recommendation }` |
| attach-4a | 生成搜尋詞 | 當前章節 title(由 `attachCursor` 指向)、`level`、`skill` | `{ query }` |
| attach-4b | 判斷影片相關性 | 章節 title、`candidateCache` 候選 metadata、時間戳 | `{ chosen, videoId, startTime, endTime, adequate }` |

對應關係:
- assess 的 `needMoreProbing`(布林)→ 直接餵 Obs1 判斷要不要追問
- generate 的 `chapters` → 直接寫進 `content.lecture`
- choose 結果 → 寫進 `profile.preference`、`planning.directionChosen = true`
- attach-4b 的 `adequate`(布林)→ 餵 Obs3 判斷要不要重搜;
  全不 adequate 且重試達上限 → 記進 `control.degraded`
- attach-4b 的 `{videoId, startTime, endTime}` → 寫進 `videoMap[章節id]`

### Step 4 是兩個子任務

attach 不是單一 prompt:先 4a 生成搜尋詞 → 呼叫 YouTube Search + Metadata
Parser → 再 4b 判斷相關性。4b 就是 Obs3 的判斷依據。

---

## 明確不要做的事(避免過度工程)

- **不要加 SQLite。** State 是純資料,JSON 檔 `stringify`/`parse` 就夠。
  只有當「跨多使用者多 session 且需要查詢」或「配額快取要跨 session 共用且變大」
  時才考慮——且即使如此也只搬快取那一塊,不整包搬進資料庫。
- **不要規劃 skill / plugin / capability 註冊框架。** 步驟是固定已知的五步,
  能力只有兩個 Tool 函式 + 純 prompt 步驟。一個只裝兩個成員的註冊表只會
  增加間接層、害 debug。等到 Tool 長到 5、6 個且常新增,或要讓 LLM 自己
  動態選 tool 時,再回頭加薄薄一層註冊即可。
- **不要把純 prompt 步驟包成 Tool。**(評估、選課)
- **不要引入 agent 框架。** 自己寫 while 迴圈是刻意決定。
- **不要在 State 裡塞非純資料**(函式、class instance、Date)。

---

## Debug 與開發提示

- State 是純資料 → 任何時候都能 `JSON.stringify` 印出來看,善用這點。
- `currentStep` 是迴圈真相來源,卡住時先印它。
- Provider 層的 JSON parser 要能容錯(markdown 圍欄、多餘文字)。
- 配額問題:盯 `candidateCache` 命中率與 `searchRetries`,重搜太兇會燒光配額。