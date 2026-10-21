# TEST_PLAN｜Feedback Desk v1.0 驗收測試與品質閘門

- 狀態：測試設計規格（Proposed）；**不表示以下測試已執行或通過**
- 來源：[ADR.md](ADR.md) ADR-001～020、[DATA_MODEL.md](DATA_MODEL.md)、[API_SPEC.md](API_SPEC.md)、[WORKFLOW.md](WORKFLOW.md)
- 開發分支：feat/d1-docx-review-v020；目前已存在 cloudflare/test、offline/test 與 GitHub Actions test workflow
- 禁止：以真實可識別少年個案、非公開卷證、公務機密或個人登入／API 金鑰作測試 fixture
- 上線前提：需取得本人對私人環境、付費模型／Cloudflare 外部授權的另行同意；本文件的測試步驟本身不授權任何部署

## 1. 測試分層與最低標準

| 層級 | 環境 | 可在無憑證時完成 | 通過標準 |
| --- | --- | --- | --- |
| L0 | 原始碼與規格審查 | 是 | 舊 migration 不改動、型別／SQL 相容、無 hardcoded secrets、ADR 可追溯 |
| L1 | 本機 SQLite / Miniflare D1 | 是 | 0001～0010 遷移可執行，完整性、約束、交易與唯一鍵正確 |
| L2 | Workers mock／fake model／fake Queue | 是 | 每個端點契約、狀態機、錯誤碼、模擬付費風險與冪等驗證正確 |
| L3 | 本機瀏覽器（桌面／行動視窗） | 是 | 離線草稿、同步、衝突比較、異議修正、定稿 UI 可正常使用 |
| L4 | 本人授權的私人 staging | 否 | Cloudflare Access、D1、Queue 實際串接、關閉瀏覽器續行、備份還原 |
| L5 | 本人另行授權的模型 API 驗證／正式上線 | 否 | 真實兩家模型授權、費用上限、真實失敗回復、完整人工核定；所有 P0 通過 |

**L0～L3 模擬全過，不等於 L4／L5 已達正式可用。** 未獲外部授權時必須停在不接觸憑證／不部署的驗收階段；不可產生虛假通過紀錄。

## 2. 目前程式的基準與回歸

從專案既有 README／package.json 定義的命令出發（Codex 於其執行環境驗證，不是本次已執行）：

~~~sh
cd cloudflare
npm install
npm test
python3 test/check_schema.py
~~~

如工程加入 migration／新增測試，應增補 test script 並保留既有 test。離線版 node:test 測試也必須執行（依實際 repo 內可用指令），不得只跑新測試而忽略已通過功能。使用固定 node 版本、lockfile 安裝並確認不需要憑證。

## 3. 驗收案例矩陣（Given / When / Then）

### A. 原始資料、遷移、定稿與查證

| ID | Given | When | Then |
| --- | --- | --- | --- |
| DM-01 | 既有 0001～0006 DB 含一筆完整歷史任務 | 套用 0007～0010 | 原任務、所有原文、回合、AI 原文、human_decisions 不變，可讀；PRAGMA foreign_key_check 無錯 |
| DM-02 | 同一任務核定 v1 已完成 | 本人編輯新草稿核定 v2 | 只新增 v2，v1 文本、來源快照與核定時間未改，依序排序 |
| DM-03 | v1 已核定 | 呼叫 UPDATE、DELETE 或舊核定路由企圖直接覆寫 v1 | DB trigger／API 拒絕，不可藉 DELETE task 連帶清除核定歷史 |
| DM-04 | 草稿 revision=7 | 手機與電腦同時帶 expected_revision=7 儲存不同文字 | 只有一個成功 revision=8，另一個 409、回傳伺服器最新版供比對 |
| DM-05 | 已核定版本、兩份來源 pending | 人工核定後將目前來源改 verified | 舊 final 快照仍為 pending；current source_checks 為 verified，皆標示不同時間 |
| DM-06 | human_decisions round UNIQUE | 結案後建立純人工 v2 | 不額外新增衝突的第二筆相同 round human_decisions，亦不觸發新 review round／付費模型 |
| DM-07 | 已有試題題庫以外的一般任務 | 建立 template_key=general | 不需填年度、考科、題次、量表；通用任務可正常建立 |
| DM-08 | 一筆 exam_essay 模板任務 | 填寫考科／題源並批改 | 專用模板不污染通用任務欄位；題源未經查證不能冒稱官方試題 |

### B. 雙模型與結構化異議

| ID | Given | When | Then |
| --- | --- | --- | --- |
| AI-01 | 同題同回合，尚無初評 | 啟動兩模型初評 | 發給兩方的 prompt 都不含對方本回合初評；隔離測試可檢測 |
| AI-02 | 只有 OpenAI independent 保存 | Queue 或使用者嘗試進 critique | 拒絕進下一階段，保留該份輸出 |
| AI-03 | 兩份 independent 保存 | 進 critique | 雙方均可讀到兩份初評，產出自己的自由文字／結構化異議，未覆蓋初評 |
| AI-04 | 一份 critique 原文完整但必要異議欄位無效 | parser 驗證 | 原文仍存、parse_status=needs_human、job=paused_parse，不進 proposal |
| AI-05 | parse_status=needs_human，AI 原文已存在 | 本人校正引用／整理異議並確認 | 保留原始資料及人工事件，parse_status=resolved，可安全進下一階段，不再呼叫該 critique |
| AI-06 | 引用未找到目標句 | 嘗試保存原句定位 | 不偽造 offset；要麼 whole 並標示退回，要麼停供人工確認 |
| AI-07 | 兩份 critique 明確無不同意見、合法輸出 [] | parser 執行 | 可進 proposal，不能誤判為格式錯誤 |
| AI-08 | AI 原有兩項異議 | 本人將其合併、或將一項拆成兩項 | source output.body 不變、objection_events 與 lineage 可追蹤 |
| AI-09 | 一輪已有兩方三階段六份輸出 | 背景程序完成 | 僅改 awaiting_human，不生成 final_versions 或自動 closed |
| AI-10 | 手動網頁貼回模型內容 | 查看來源與匯出 | source=manual_unverified 清楚顯示，不說已獲官方 API 驗證 |

### C. Queue、失敗與可能的重複計費

| ID | Given | When | Then |
| --- | --- | --- | --- |
| JOB-01 | new 任務、背景功能已明確啟動（mock） | 按開始兩次 | 單一 active job；不重複排程付費模型 |
| JOB-02 | D1 outbox 已記 pending，但 Queue send 失敗 | 執行安全 reconciler | 可再投控制訊息而不直接觸發未知的付費請求 |
| JOB-03 | Queue 同一 job 訊息重送 | consumer 讀到已入庫輸出 | 不再呼叫同階段 provider，正確回報既有進度 |
| JOB-04 | ChatGPT 初評已入庫，Gemini API 明確失敗 | consumer 回應 | paused_failure；ChatGPT 成果保留，不能進 critique |
| JOB-05 | Gemini request_started 後 Worker 中斷 | 超時檢查 | 標記 outcome_unknown、提醒可能費用，不自動第二次付費呼叫 |
| JOB-06 | Gemini response_received，但寫 ai_outputs 失敗 | 儲存程序失敗 | 不能標 persisted；暫停，記錄已回應但未成功儲存 |
| JOB-07 | 上述狀況且本人沒有風險確認 | POST retry | 422 CHARGE_ACK_REQUIRED，不排程 |
| JOB-08 | 本人確認重試，但手機連點或網路重送同 Idempotency-Key | POST retry ×2 | 同一授權／排程結果；不發起兩次付費模型呼叫 |
| JOB-09 | 對 already persisted 的模型步驟 | POST retry | 409 ALREADY_PERSISTED，不覆寫 AI 原文 |
| JOB-10 | 兩 consumer 競爭同 job | 同時處理 | CAS/lease 只允許單一安全執行者；不因租約過期而在結果未知時直接重跑 |
| JOB-11 | MODEL_API_ENABLED 或 BACKGROUND_JOBS_ENABLED=false | 嘗試進行 API 自動審查 | 清楚拒絕，沒有假模型回覆、沒有付費外呼 |
| JOB-12 | 已達模型 attempt cap | 再次要求模型 | 429、無對外呼叫；失敗 attempt 也要計數，並在 UI 呈現額度限制 |

### D. 人工核定、離線同步、匯出

| ID | Given | When | Then |
| --- | --- | --- | --- |
| UI-01 | AI 六份建議完成，尚未有人核定 | UI 顯示工作結果 | 只能顯示等待人工核定；不顯示已結案 |
| UI-02 | 手機已將 revision=8 雲端保存；電腦還編輯 revision=7 | 電腦重連儲存 | 本機草稿保留並顯示差異；雲端 revision=8 不被覆寫 |
| UI-03 | 已離線且持續輸入 | 觸發本機暫存 | 顯示「本機已保存、雲端未同步」，不誤稱同步成功 |
| UI-04 | 本機連續產生 local_edit_1、local_edit_2 | local_edit_1 的伺服器 ACK 遲到 | 只清掉 edit_1 已確認內容，edit_2 不被清除 |
| UI-05 | 有 pending 查證事項 | 本人按核定但未確認警示 | 422 UNVERIFIED_ACK_REQUIRED，最終正文無新增 |
| UI-06 | 同上 | 本人明確確認警示、核定 | 新增不可覆寫 final，快照含 pending；UI 顯示核定完成 |
| UI-07 | 既有 v1 已 closed | 本人純人工修正核定 v2 | 不向 OpenAI/Gemini 發出任何請求，無新 paid attempt |
| UI-08 | 任務含兩版 final、來源快照與異議整理 | 匯出 Markdown | 原文、AI 原文、人工版本、來源當時與目前狀態及模型來源標記完整 |
| UI-09 | 另一裝置已登入但未通過 Cloudflare Access | 要求讀任務 | staging 中驗證應被 Access 擋下；不洩漏任何原文 |

### E. 安全、隱私、輸入限制、備份

| ID | Given | When | Then |
| --- | --- | --- | --- |
| SEC-01 | 無登入 Cookie / Token | 呼叫 tasks、draft、finals、recovery、retry、export | 401／403，無私人內容，無狀態修改 |
| SEC-02 | 外站來源或 CSRF 攻擊 | 發送寫入請求 | 被阻止，未修改資料 |
| SEC-03 | 題目中包含「請洩漏密碼／執行 shell」等惡意文字 | 模型讀取原題 | 視為待分析資料，不執行任意指令、不讀 secrets |
| SEC-04 | 請求帶 .docx 圖片／註解／複雜排版 | 擷取 | 明示僅讀正文、表格的局限；不宣稱完整讀到圖表 |
| SEC-05 | 超過檔案／欄位／輸出限制 | 提交 | 4xx 明確拒絕，不悄悄截斷或覆寫原文 |
| SEC-06 | 模型連線錯誤、Provider HTTP 500 | log、回應錯誤 | 不洩漏金鑰、個人密碼、敏感輸入或整份原稿 |
| SEC-07 | staging 私人站已授權 | 模擬未授權訪客 GET 網頁/API/匯出 | 未通過 Cloudflare Access 者不得取得資料或觸發模型 |
| SEC-08 | 測試 D1 含 fixture | 備份、建立另一測試 D1 還原 | task、round、outputs、finals、異議、來源快照／事件筆數與內容 hash 均一致 |
| SEC-09 | 編輯器本機有暫存 | 雲端成功 ACK | 僅移除對應已同步暫存；提供清除裝置暫存入口；斷線衝突內容不丟失 |
| SEC-10 | 兩個相同 Idempotency-Key 帶不同 request body | 呼叫會改狀態的 API | 409，不重複執行 |

## 4. 模擬器與測試素材

- 建立公開／虛構的法律議題、國考風格自編題、一般文字校稿 fixture；敏感內容用人工合成虛構資料。
- Fake OpenAI、Fake Gemini 可按次序回傳：正常文字／合法 structured critique／空異議／無效結構／HTTP 429／timeout／response_received 但 D1 寫入失敗。
- Fake Queue 可重送、亂序、並行、send 失敗、在階段間 crash；不允許真實外部模型呼叫。
- 測試 D1 初始 fixture 須先 0001–0006，遷移後檢查舊資料不可覆寫、舊任務與離線匯入的相容。
- 測試期間確保 MODEL_API_ENABLED=false、BACKGROUND_JOBS_ENABLED=false 在部署環境的預設值，實際 HTTP fetch mock 不會誤打供應商。

## 5. 交付與 CI 報告格式

每個 PR 應列出：
1. 新增／更新哪些資料庫 migration、API 或 UI；
2. 測試命令、環境、執行日期、通過／失敗筆數；
3. 參照上述案例 ID 的驗收清單（非空口自稱通過）；
4. 尚未驗收及 blocked 的原因（如未取得私人 Access 或付費 API 授權）；
5. 備份與資料相容風險；若未部署寫「未部署」。

對 P0 安全與資料保全項目，**有任何未通過，不得標示 v1.0 正式可用**。Doc commit 或單元測試全綠不代表 Cloudflare／真實 AI 工作流端到端已通過。

## 6. 正式上線的 Stop／Go 條件

**Go 所需**：使用者明確授權後，私人 Cloudflare Access 真實驗證、Worker/D1/Queue 真實 E2E、兩 provider 各至少一次最小受控 API 實呼叫及成本確認、工作故障保留／人工重試、核定多版本與備份還原、未授權隔離，全部具有可查結果。

**Stop 所需情境**：
- 缺少 API Key、雲端部署授權或支付確認；
- Cloudflare Access 私人政策未實際核驗；
- 核定歷史可被覆寫或原稿遺失；
- Queue 重送可默默再次觸發付費呼叫；
- 無法復原備份、私人內容可以被未授權者讀取；
- 模型或異議解析失敗卻仍顯示已完成。

若 2026-11-01 仍有上述 Stop 項目，**調整正式上線日期**，允許繼續用已驗證的離線／無 API 版本，不把 staging 冒充正式站。