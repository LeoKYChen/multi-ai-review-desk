# IMPLEMENTATION_PLAN｜Feedback Desk v1.0 Codex 分階段開發計畫

- 版本：2026-10-21，工程移交草案（Proposed）
- 目前已確認：ADR-001～020，核心架構決策已收斂，不再以逐輪 grilling 延後實作
- 儲存庫：LeoKYChen/multi-ai-review-desk
- 開發基準：feat/d1-docx-review-v020；PR #1 目前為 Draft；main 現階段不直接更動
- 首要限制：**沒有本人另行授權不得觸碰 API Key／Token／密碼、Cloudflare 部署、遠端 D1、正式 Queue 或真實付費模型**。以下編寫的是未來給 Codex 使用的工程工作單，不代表現在執行了它。
- 目標日期：2026-11-01 是願景／可行性檢核日，並非可以犧牲安全閘門的強制正式上線日

## 1. 專案最終定位（不要再重新設計）

- **獨立私人工作臺**：不與觀護人學習平臺介接；通用文字與問題雙 AI 協作，國考申論批改採可選模板。
- **固定雙模型三階段**：OpenAI API 與 Gemini API 獨立初評、交叉異議、各自修正；保留完整原文及結構化爭點。
- **人工唯一核定者**：本人可改寫草稿、整理異議、核定多份不可覆寫版本、帶未查證警示結案；草稿與正式版本分開。
- **背景安全**：Cloudflare Workers + D1 + Queue；離開網頁仍能執行；模型不確定是否計費時必須暫停並人工確認。
- **不做**：AI D 總審查官、全面自動網路查證、Dify/n8n 編排、原版 Feedback Desk 重新 fork、R2/Google Drive 附件永久儲存、公共多使用者註冊。
- **模型存取與費用**：OpenAI/Gemini 網頁訂閱不等於 API 存取；沒有提供者授權時，仍可使用原本的 manual 模式，不假裝一鍵自動運作。

## 2. Codex 必讀文件與順序

1. [GLOSSARY.md](../GLOSSARY.md)：域名與語意；
2. [ADR.md](ADR.md)：20 項已核定決策；
3. [DATA_MODEL.md](DATA_MODEL.md)：0007～0010 migration、鍵值、原子性、不可覆寫；
4. [API_SPEC.md](API_SPEC.md)：既有／新增端點、JSON、身分與衝突語意；
5. [WORKFLOW.md](WORKFLOW.md)：狀態機、工作流程、安全重試；
6. [TEST_PLAN.md](TEST_PLAN.md)：Given/When/Then 測試、是否允許上線的客觀條件；
7. 現有 README、cloudflare/README.md、cloudflare/migrations/0001～0006、cloudflare/src/worker.mjs、manual.mjs、models.mjs、background-review.mjs、guardrails.mjs、export.mjs 及既有測試。

若工程規格和已核定 ADR 發生衝突，以 **ADR 為產品決策真相**，不得擅自以程式方便為由推翻。實作細節存在多個合理選項時，Codex 在 PR 說明採用方式與取捨；只有會改變使用者已核定行為的變更才再次提出待決策。

## 3. 進度／依賴概覽

~~~text
Phase 0 既有程式與測試基線
    │
Phase 1 D1 migration 0007～0010 與舊資料相容
    ├────────────────┐
Phase 2 安全工作引擎與 attempt/Queue 恢復
    │                ├── Phase 3 異議、來源、人工整理
    │                │
    └────────────────┴── Phase 4 人工草稿、定稿與 API
                               │
                         Phase 5 網頁 UI、離線暫存、匯出
                               │
                         Phase 6 端到端／安全／備份驗收
                               │
                         Phase 7 經本人另行授權的私人部署與上線
~~~

Phase 0～6 的本地 mock、測試、文件、Code Review 可以在**不提供任何新憑證**下進行（取決於開發工具是否已具備 GitHub 存取權）；Phase 7 一律暫停，直到本人在個人安全環境完成必要授權。不得為了 11 月 1 日提前跳過。

## 4. 工程階段與驗收標準

### Phase 0｜現況凍結與回歸基線

**工作**
- 確認原始程式分支、PR 與測試矩陣，記錄當前狀態／缺口，建立合成 fixture；
- 驗證 existing cloudflare npm test、SQLite schema 檢查與 offline 測試可執行；
- 確認既有 .docx 文字擷取會提醒格式、圖片、註解無法保留的限制；
- 檢查部署 workflow 為手動／預設關閉，環境未意外啟用 MODEL_API_ENABLED 或 BACKGROUND_JOBS_ENABLED；
- 規格文件只讀，未在此階段操作私人 Secrets。

**完成定義（DoD）**：一份真實測試結果與版本號、失敗清單；不修改正式環境、不宣稱模擬成功代表已部署。

### Phase 1｜D1 schema 與遷移

**預期變更**
- 新增 cloudflare/migrations/0007_*.sql：template_key、human_drafts、final_versions 與 immutable trigger；
- 新增 0008_*.sql：ai_output_metadata、critique_parse_status、review_objections、objection_events 與 lineage；
- 新增 0009_*.sql：source_checks、source_check_events；
- 新增 0010_*.sql：review_jobs、review_model_attempts、retry_authorizations、queue_outbox、mutation_idempotency；
- 注意 final_versions 與 human_drafts 的 FK 建表順序、source_snapshot_json 的核定快照、跨 task/round 識別驗證、交易原子性；
- 新增 tests 驗證 0001～0010 遷移前後的原始內容與既有索引／CHECK 均正常，避免 destructive migration。

**DoD**：TEST_PLAN DM-01～DM-08 L1 全過；已核定版本 UPDATE/DELETE 失敗，舊資料完整。不要對遠端 D1 apply migration。

### Phase 2｜安全 Queue 與模型呼叫資料一致性

**預期變更**
- refactor cloudflare/src/background-review.mjs、worker.mjs、guardrails.mjs，以及必要的新 job／attempt 模組；
- 將「預留次數」、「送出 provider」、「收到回覆」、「持久化輸出」標記分開；
- 保證 ai_outputs 入庫與 attempt.persisted 的一致性；未知結果不能作安全重試；
- 加入 outbox 的安全投遞／重送控制、每任務 lease/CAS、同 key 冪等，避免雙擊及併發重呼叫；
- Queue payload 僅含 UUID，日誌不輸出私人文件或憑證；
- 未授權情況下不得啟動任何真實模型 API。

**DoD**：TEST_PLAN JOB-01～JOB-12、SEC-03／SEC-04；用 fake provider 驗證「已回應但存庫失敗」及 request_started 後崩潰。確認不能形成隱藏的第二次付費呼叫。

### Phase 3｜異議解析、人工整理與查證來源

**預期變更**
- 擴充 models.mjs 的 critique prompt 與輸出解析，保留原始全文，額外解析結構化異議；
- 嚴格驗證 target_output_id／quote 與原句位置，失敗時降級 whole 或停人工，不捏造偏移；
- 解析必要欄位失敗，設定 paused_parse；新增本人可更正、合併、拆分與 resolve 的 API／事件；
- 新增 source_checks 與 source_check_events API，包含 verified 只能由本人確認；
- AI 兩方都無異議的合法空清單可過關；若有無法可靠解析的異議則不能前進。

**DoD**：TEST_PLAN AI-01～AI-08、DM-04/05，保證不同 task 的輸出不可交叉引用、AI 原文不能人工覆寫。

### Phase 4｜人工草稿與不可覆寫定稿 API

**預期變更**
- GET/PUT draft 以 expected_revision 進行原子 CAS，衝突回 409、含比較需要的內容；
- finals 的 GET/POST 與歷史版本、snapshot、parent_version_id，已核定版本只讀；
- 顯示未查證清單並要求核定警示確認，但不阻擋本人自主核定；
- 已有 closed 任務建立 v2 為純人工操作，絕不可觸發 AI；必要時由另一明確「重新進行雙 AI 審查」命令開新 round；
- 既有 POST /review 不得繞過正式核定版本；保留退回重議舊紀錄相容；
- final_versions 新增、查證快照、相關 human decision/status 必須原子化；
- 所有端點以本人登入、同源／CSRF、Body 驗證保護。

**DoD**：TEST_PLAN DM-02/03/04/05/06、UI-05/06/07、SEC-01/02/10，原有資料保留。

### Phase 5｜UI、離線暫存、雙模型對照與 Markdown 匯出

**預期變更**
- 修改 cloudflare/public/app.js、index.html、style.css：兩模型原文、異議原句定位、人工整理、歷史版本、核定快照／最新狀態、恢復風險；
- 本機採 IndexedDB 或等效可測試方案暫存未同步草稿；明示本機暫存的隱私風險與手動清除方式；
- 復線先讀 D1 revision，衝突時並排比較，不能 last-write-wins；成功 ACK 只刪除**對應 local_edit_id 的已同步項**；
- 任一 AI 失敗時顯示已保留的單方結果及待重試，不能顯示成功；
- 修改 export.mjs 完整匯出 v1/v2 不可覆寫定稿、原始批改、人工異議事件、當時來源快照、最新查證與 manual_unverified 標記；
- 保留既有離線版回合閱讀和備份流程；必要時新增離線 JSON/D1 相容驗證。

**DoD**：TEST_PLAN UI-01～UI-09；離線復線及兩裝置草稿競爭在實際瀏覽器 mock 測試成功。

### Phase 6｜全面本地驗收與 release candidate

**工作**
- 執行原測試 + 新測試，SQLite dry run（0001～0010）、fake Queue、fake OpenAI/Gemini、瀏覽器自動化；
- 做故障注入、來源查證變更與核定快照、同任務多版本、身份驗證與匯出不洩密；
- 在獨立本地測試庫執行備份還原，核對筆數與 hash；
- 完成 release checklist：標記 L0～L3 已通過與 L4／L5 未驗證項目；不可將 blocked 項目寫作 pass；
- 確保使用者不提供任何敏感資料或真實少年卷宗進行模擬驗收。

**DoD**：已確認的 P0 核心行為全部 L0～L3 綠燈；開發文件、測試結果與限制完整可供審查；沒有發生未授權對外操作。

### Phase 7｜私人 staging、真實模型與正式切換（**本次明確不做**）

只有本人另行明確授權時：
- 本人在 Cloudflare 安全控制臺完成必要金鑰／Access 政策／費用限制，agent 不索取或抄錄；
- 真實 Cloudflare Access 拒絕非本人，且 GET/POST/匯出受保護；
- 真實 Workers + D1 + Queue 的手機／電腦與瀏覽器關閉後續行 E2E；
- 在受控最低額度內分別驗證 OpenAI/Gemini API，核對費用與失敗行為；
- 在另一測試 D1 驗證備份還原，最後才考慮正式 cutover；
- 同意發布、合併 PR 與啟動服務要另行確認，不因 CI 綠燈而自動生效。

**正式站停止條件**詳 TEST_PLAN.md。若 11/1 仍有外部授權或 P0 問題，保留可用離線／manual 模式並延後正式上線。

## 5. 各階段 PR 切分與 Codex 工作單

建議每階段獨立可檢視的 PR／commit（是否建立分支、PR 或合併需本人按階段授權）：

| 階段 | 建議工作單主題 | 必須附上 |
| --- | --- | --- |
| 0 | 基線驗收與 fixture | 原測試執行結果、工作範圍 |
| 1 | D1 0007–0010 | schema migration dry run + FK／immutable 測試 |
| 2 | background jobs and cost-aware retries | 失敗注入、冪等與不重複呼叫證據 |
| 3 | objections and evidence provenance | 引用驗證、AI 原文、修訂事件測試 |
| 4 | human draft/final APIs | CAS、版本不可覆寫、交易與舊端點相容 |
| 5 | UI/offline/export | 瀏覽器測試、跨裝置與斷線情境 |
| 6 | release candidate QA | 驗收矩陣、未通過事項、風險清單 |

不要在尚未完成單一階段 DoD 時將所有模組一次大改；避免同時遷移、部署及開啟付費 API 難以回復。

## 6. Codex 可直接使用的工作指令（不含憑證）

~~~text
你是資深 TypeScript/Cloudflare Workers 工程師。請在
LeoKYChen/multi-ai-review-desk 的開發分支 feat/d1-docx-review-v020
以 README、GLOSSARY.md、docs/ADR.md（ADR-001～020）、
docs/DATA_MODEL.md、docs/API_SPEC.md、docs/WORKFLOW.md、
docs/TEST_PLAN.md、docs/IMPLEMENTATION_PLAN.md 為實作契約。

先只執行 IMPLEMENTATION_PLAN.md 的 Phase 0／Phase 1：
1. 閱讀既有 migrations/0001～0006、Worker/Queue/模型/手動模式程式及測試。
2. 建立 0007～0010 的增量 D1 migration，禁止改寫舊 migration 或原始任務。
3. 建立本機 SQLite/D1 schema、trigger、FK、CAS 與舊資料保留的單元/整合測試。
4. 執行既有及新增測試，回報實際通過數、失敗數、執行命令與下一步。

必要限制：
- 不要求、讀取、修改或提交任何 API Key／Token／密碼。
- 不登入或部署 Cloudflare，不套用 remote D1 migrations。
- 不呼叫真實 OpenAI/Gemini，不啟用付費模型或 Queue。
- 不在沒有我單獨同意前 merge main、發布網站或執行破壞性操作。
- 遇到涉及外部授權、付費、敏感文件或重大架構分歧立即停止，說明需由我完成的操作。
- 每個資料表與 API 必須保護人工核定不可覆寫、原始 AI 原文留存、版本衝突、安全恢復與來源快照。
- 給出本階段結果後停下，等待我授權 Phase 2。
~~~

## 7. 本階段成果對使用者的可理解說明

完成階段 1 代表「資料庫準備好保留兩位 AI 的發言、分歧、我的草稿與正式版本」，**不是** AI 已能自動討論。

完成階段 2、3 代表「電腦懂得保留部分成功結果，遇到不確定費用會停下，異議可以逐項追查」，**不是** 已連上真實模型。

完成階段 4、5 代表「我可以在網站編輯定稿、核定版本、離線暫存、比較差異」，**不是** 網站已通過私人雲端安全驗收。

只有經本人另外授權、Phase 7 真實完成並核對 Test Plan 的 Go 條件，才能稱為正式可用。

## 8. 不做的工程承諾

- 不承諾 11 月 1 日前能取得模型 API 或 Cloudflare Access 的實際授權；
- 不承諾第三方 API 完全不會因中斷重複計費；
- 不把多人 Agent 交接的原版 Feedback Desk 功能視為自有 repo 現成可用；
- 不因 AI 間的共識而宣稱法律、學理或外部資料已查證；
- 不因編輯器顯示「本機已暫存」而表示 D1 資料已同步；
- 不在本輪文件交付後無人授權自動進入後續實作、部署或正式使用。