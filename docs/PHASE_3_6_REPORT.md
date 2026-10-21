# Feedback Desk｜Phase 3–6 開發與驗收報告

- 版本日期：2026-10-21
- 儲存庫：LeoKYChen/multi-ai-review-desk
- 分支：feat/d1-docx-review-v020；PR #1 仍為 Draft，未合併 main
- 本階段授權範圍：依已核定 ADR-001～020，連續推進 Phase 3（異議及來源）、Phase 4（人工定稿）、Phase 5（前端與匯出）、Phase 6（隔離環境驗收）
- 絕對未操作：Cloudflare 遠端 D1／Queues／Workers 部署、任何個人或付費模型 API Key／Token／密碼、真實 OpenAI 或 Gemini 請求、真實可識別少年案件資料

## 1. 功能實作成果

### Phase 3：結構化異議與來源查證

- 模型交叉評論新增「完整自然語言評論＋BEGIN_FEEDBACK_OBJECTIONS JSON 區塊」提示。
- 在單次 D1 batch 中保存原始 AI 回覆、模型執行 persisted 狀態、評論解析狀態與合法結構化異議；不丟失原文。
- 引文必須直接在對應獨立初評原文中找到。唯一定位可保存原句／段落錨點；模糊重複引用退回整篇定位；引文不存在時標示 needs_human，不能虛構原句。
- 有效空異議 [] 可前進；輸出不合格式時保存完整原文、暫停後續模型；本人確認／補正後才繼續缺漏階段。
- 支援本人新增、修訂、合併、拆分結構化異議，使用不可覆寫的事件紀錄與來源連結。
- 來源查證 API：目前 verified／pending／model_inference、查證人與時間、來源名稱、網址／定位及人工核對理由。不得以雙模型共識自動標為 verified。
- 關鍵檔案：cloudflare/src/review-evidence.mjs、models.mjs、safe-review.mjs、worker.mjs，以及 review-evidence.test.mjs。

### Phase 4：人工草稿與核定版本

- GET／PUT /api/tasks/:id/draft：依 expected_revision 的 CAS；舊版寫入 409，附雲端版本與正文供人工比較。
- GET／POST /api/tasks/:id/finals、GET /api/tasks/:id/finals/:finalId：只由本人核定正式文字；舊版不可 UPDATE/DELETE，同一任務可有 v1、v2 及後續修訂。
- 核定時使用伺服器草稿正文，不接受客戶端直接提交「假定稿」；以 D1 batch 一併保存正文、核定當時查證快照、版本鏈、人工決定與任務狀態。
- 同一 Idempotency-Key 相同請求返回相同結果，不同內容回 409；同一回合不重複插入 human_decisions。
- 有待查證事項時提醒並要求本人確認，但不阻止本人核定；事後 source_checks 轉 verified 不修改 v1 原始 pending 快照。
- 舊 POST /api/tasks/:id/review 非 rework 的直接結案路徑被拒絕，避免不存正式文字即顯示已核定。
- 新版人工修訂與儲存草稿均不呼叫 AI、不收費。
- 關鍵檔案：cloudflare/src/human-finals.mjs、worker.mjs，以及 human-finals.test.mjs。

### Phase 5：瀏覽器介面、離線暫存、匯出與模板

- 現有工作臺加入本人編輯完整定稿、版本歷史閱讀、來源核對、結構化異議檢視與編修、失敗風險警示和缺漏模型人工確認重試面板。
- IndexedDB 只保存**未同步的草稿**；每次本機修改有獨立 local_edit_id。僅伺服器確認相同編輯成功，才清除對應項目；晚到的舊 ACK 不能刪除新草稿。
- 跨裝置版本不同，介面顯示雲端／本機內容供比較，需本人決定採雲端版或明確以本機版更新；不默默覆寫。
- 通用任務與國考申論模板以 template_key 區分。國考專用批改指引僅於 exam_essay 開啟，不污染通用模式；第一階段仍維持模型互相隔離。
- 完整 Markdown 匯出含歷次 AI 原文、人工異議軌跡、所有正式核定全文、每版核定當時來源快照與目前查證清單；不含原始 Word 位元組或密鑰。
- 關鍵檔案：cloudflare/public/app.js、review-ui.js、draft-cache.js、index.html、style.css；cloudflare/src/export.mjs；draft-cache-ui.test.mjs。
- **重要**：此階段通過模組語法、API 整合、DOM ID 靜態檢查、離線比對純函式測試；**尚未真正使用 Chrome/Safari 的手機與電腦執行完整 UI E2E**。

### Phase 6：隔離環境驗收

- 使用 GitHub Actions 隔離 runner、Node 22、Node:sqlite 假 D1、假 Queue、假模型及 Python SQLite 完成自動化測試。
- 新增 check_backup_restore_v1.py：套用 0001～0010，插入合成任務、AI 原文、異議事件、已核定版本、來源快照、背景工作與重試資料，在另一個 SQLite 檔案備份還原，逐表核對 SHA-256、FK 與 immutable trigger。
- 增加 CI 對 app.js／review-ui.js／draft-cache.js 的 ES module 語法檢查。
- 更新模型專用模板單元測試、六份合法結構化雙 AI 模擬流程與人工異議解析恢復測試、實際登入後草稿與核定 API／Markdown 匯出測試。
- CI 不部署、不中斷或修改任何 Cloudflare 正式工作，也不接觸真實模型費用。

## 2. 已完成的 CI 實際結果

GitHub Actions：
https://github.com/LeoKYChen/multi-ai-review-desk/actions/runs/39626025566

對應 commit：3279a5abec97e174849612c0bc00ac90967799c2

| 檢查 | 實際結果 |
| --- | --- |
| Worker、兩模型 mock、Queue、草稿、人工定稿、異議、DOM 契約等 Node 測試 | **99 通過，0 失敗** |
| 離線 HTML 回歸測試 | **8 通過，0 失敗** |
| 離線備份轉換 | **7 通過，0 失敗** |
| 0001–0010 migration、既有資料相容、資料防覆寫及呼叫數上限 | PASS |
| Phase 6 獨立 SQLite 備份還原、雜湊一致與 FK 驗證 | PASS |
| 三個前端 ES module 語法 | PASS |
| 工作整體結論 | **Success** |

測試皆使用虛構文字及隔離環境；**不能視為真實 Cloudflare Queue、Browser 或模型 API 的端到端驗收**。

## 3. 尚待真實環境驗收（不得勾選 Go）

| 項目 | 現況 | 為何需要本人／獨立授權 |
| --- | --- | --- |
| Chrome/Safari 手機與桌面真實 UI E2E | 未執行 | 目前只有語法、DOM 靜態與純函式驗證；需允許提供可互動的瀏覽器測試環境 |
| Cloudflare Access 私人存取政策 | 未驗證 | 必須由本人確認只允許自己登入／查看文稿 |
| 真實 Workers + D1 + Queue + Cron 行為 | 未執行 | 需要私人 staging、雲端配置與明確部署授權 |
| API Key、模型 ID 與兩供應商用量／費用 | 未設定／未驗證 | 只應由本人在供應商及 Cloudflare 的安全控制介面配置；不應貼在對話、程式或 GitHub |
| 真實環境併發、逾時與費用上限 | 未驗證 | SQLite mock 不等於第三方 API 計費或實際 Cloudflare 分散式服務 |
| 私人 staging D1 備份還原 | 未執行 | 需已獲授權的隔離遠端測試庫；絕不直接還原至正式資料庫 |
| PR 合併 main、正式網域／正式上線 | 未執行 | 本人明確核准後才能執行 |

**Phase 6 判定**：本地單元、mock 整合、資料庫 dry-run 與離線備份／還原已完成；L3 真實瀏覽器、L4 私人雲端 staging、L5 兩家實際模型及費用、正式切換均未通過。故只可稱為「本地 release candidate」，**不可稱 v1.0 正式上線已完成**。

## 4. 上線前風險與使用限制

1. Word 仍只擷取正文文字，原始 .docx 位元組、圖片、註解、複雜版面不永久保存，也不能完整還原 Word 排版。
2. 本機 IndexedDB 暫存不是加密雲端備份，共用裝置上的草稿可能被裝置使用者接觸；使用後請確認同步與清除。
3. AI 出處、研究、法條或考古題來源未經本人親自查證前，只能為 pending／model_inference。
4. 自動 Queue 安全恢復的 Cron 仍未啟用；如果 Queue send 失敗且無人手動 reconcile，背景工作可能停留 pending。不能保證「關閉瀏覽器後任何故障都會自行復原」。
5. 供應商 API 可能因網路失敗而已計費，D1 不能準確判斷第三方帳單；系統以保留結果／停機／人工授權降低重試費用風險，**不承諾絕無重複計費**。
6. 模型呼叫上限目前限制嘗試次數，不是美元／新臺幣硬上限。
7. 正式上線前不得使用非公開司法文件、可識別少年個案或公務機密進行測試。

## 5. 本次停止點與需要的使用者決定

核心工程從 Phase 3 連續推進至 Phase 6 本地 release candidate，沒有每階段重複詢問使用者。

**現在真正需要本人介入的是下一階段的外部授權與實測**：
1. 決定是否要進行私人 staging 與瀏覽器 E2E。
2. 若同意，在本人控制的帳號中驗證 Cloudflare Access 權限、私人站部署與獨立測試 D1。
3. 真實模型測試另核准 API 使用、費用額度後再進行，使用者自行透過安全控制介面設定憑證。
4. 只有在 TEST_PLAN.md 的 L3～L5 安全與端到端條件具證據通過後，才另行決定是否 merge PR #1、正式上線。

**本次不代表獲得 Phase 7 授權；未部署、未觸碰任何私人憑證或付費模型，也未合併 main。**
