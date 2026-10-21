# Feedback Desk｜Phase 2 實作與驗收報告

- 日期：2026-10-21
- 分支：feat/d1-docx-review-v020（PR #1 Draft，未合併 main）
- 範圍：背景 Queue、模型呼叫狀態持久化、失敗暫停、使用者風險確認與冪等重試
- 對照：ADR-001～020、DATA_MODEL.md、API_SPEC.md、WORKFLOW.md、TEST_PLAN.md
- 限制：本階段只使用 GitHub、GitHub Actions 的隔離執行器、模擬模型、模擬 Queue 與記憶體 SQLite；未部署 Cloudflare、未修改遠端 D1、未使用真實 API Key／Token／密碼，也沒有付費模型呼叫

## 1. 已實作

| 檔案 | 功能 | 結果 |
| --- | --- | --- |
| cloudflare/src/safe-review.mjs | 工作／模型嘗試狀態、outbox、可能計費時暫停、人工確認重試、併發租約及安全恢復 | 已寫入、CI 通過 |
| cloudflare/src/worker.mjs | API 執行路由改用安全 Queue；移除舊版同步付費呼叫執行函式；新增 recovery、retry、reconcile；內部 Queue consumer 改用安全控制器 | 已寫入、CI 通過 |
| cloudflare/test/safe-review.test.mjs | fake D1、Queue 與模型故障注入測試 | 12 個新增 Node 測試通過 |
| cloudflare/README.md | 更新實際執行機制、路由及尚未完成的範圍 | 已更新 |
| cloudflare/wrangler.toml.example | 只加入 Cron 安全重派的註解範例，不啟用排程 | 已更新 |

資料模型沿用 Phase 1 的 0007–0010 migration；既有 0001–0010 未經修改，也沒有遠端 SQL 操作。

## 2. 主要安全保護

1. 模型呼叫的 request_started／response_received／persisted 分離。只有模型回覆與持久化狀態一起寫入 D1，才表示完成；Provider 錯誤或寫入不明時標示 outcome_unknown，暫停等待本人決定。
2. Queue 重送不覆寫已保存的 AI 原文，不自動重呼叫結果未知的 provider。控制訊息只含 UUID，不帶 Word 原稿、登入資訊或 API 金鑰。
3. 若 Queue send 失敗，資料庫 outbox 保留 pending；登入本人可執行 POST /api/jobs/reconcile 安全重派。定期 Cron 只保留待授權的設定範例，未啟用。
4. GET /api/tasks/:id/recovery 顯示已保留輸出、工作及可能重複計費警示。POST /api/tasks/:id/retry 需本人登入、明確確認費用、指定缺漏 provider／phase、使用 job revision 及 Idempotency-Key。
5. 有效租約不會因重送而被擅自暫停；過期租約若全部輸出已安全持久化，可只重派控制工作；存在未知付費狀態則暫停。
6. 舊版非背景同步呼叫模型的 Worker 路徑已移除；沒有明確開啟安全背景模式時，POST advance 不會執行模型。

## 3. 真實 GitHub Actions 模擬測試結果

已驗證成功的執行紀錄：
https://github.com/LeoKYChen/multi-ai-review-desk/actions/runs/39618802506

對應 commit：6980200fd4b7d612e66109e44575a3dbab7b66e1。

| 測試 | 結果 |
| --- | --- |
| Worker／Cloudflare／Queue Node 單元測試 | 77 通過、0 失敗（其中新增 Phase 2 測試 12 個） |
| 離線網頁測試 | 8 通過、0 失敗 |
| 離線備份轉換測試 | 7 通過、0 失敗 |
| SQLite 離線匯入 dry-run | PASS |
| D1 既有 schema | PASS |
| Phase 1 0007～0010 本地遷移完整性 | PASS |
| 瀏覽器 JS 語法 | PASS |
| GitHub Actions | Success |

測試涵蓋：模型逾時、模型已回應但 D1 寫入失敗、人工確認重試防重送、異常租約、重複 Queue 訊息、outbox 失敗重派與已保存原文不可覆寫。全部為合成資料；沒有真實雲端或模型付費請求。

## 4. 重大未完成事項（明確不可宣稱正式上線）

- Phase 3 交叉異議的可靠結構解析尚未開始；兩份 critique 文字完成後刻意停止於 paused_parse，不能宣稱完整三階段已自動完成。
- Phase 4 多版人工定稿尚未接上 Worker API；舊 POST /api/tasks/:id/review 仍保留原本的人類決定記錄語意。
- 真實 Cloudflare Workers／Queue／D1／Access、排程 Cron、手機電腦端到端、遠端備份復原和真實模型費用均尚未驗收。
- Cron 只是註解，若 Queue send 失敗且本人沒有再次打開網站操作 reconcile，可能無人自動喚醒 pending outbox。正式背景可靠性還須另行授權啟用並驗收 Cron。
- 外部模型不提供跨服務 exactly-once 計費保證；現有次數上限不等於實際金額上限。
- Web UI 尚未整合 recovery／retry 的操作介面與可見警示。
- D1 與 Queue 的真實交易／並行行為尚未實測，不能將 fake SQLite 的綠燈誤解為正式服務安全驗證。

## 5. 階段結論

Phase 2 **本地實作和 CI 模擬驗收完成**，但正式雲端端到端驗收未完成。下一階段依既定計畫為 Phase 3：結構化異議、引用定位、人工修訂與查證資料 API。

本次只執行 Phase 2，不進入 Phase 3、不合併 main、不部署、不接觸或索取任何 API 憑證。
