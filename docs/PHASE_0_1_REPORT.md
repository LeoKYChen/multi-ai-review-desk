# Feedback Desk Phase 0 + Phase 1 實作與驗收報告

- 報告日期：2026-10-21
- 範圍：現況基線盤點、累進 D1 migration 0007–0010、本機 SQLite 資料相容與約束測試
- 儲存庫：`LeoKYChen/multi-ai-review-desk`
- 工作分支：`feat/d1-docx-review-v020`（PR #1 Draft）
- 基準規格：`docs/ADR.md`（20 項 Accepted）、`docs/DATA_MODEL.md`、`docs/API_SPEC.md`、`docs/WORKFLOW.md`、`docs/TEST_PLAN.md`
- 工作界限：**未修改遠端 Cloudflare D1、未部署、未呼叫付費模型、未讀取或要求任何 API Key／Token／密碼；僅開發分支 GitHub 檔案、測試 CI。**

## 1. Phase 0：原始程式與測試基線

靜態閱讀的既有程式：
- `cloudflare/migrations/0001_init.sql` 至 `0006_background_queue.sql`：保留現有任務、回合、模型原文、人工決策、計數護欄及 queue_requested。
- `cloudflare/src/worker.mjs`：舊 `POST /api/tasks/:id/review` 的最終決定仍僅寫 human_decisions 並結案；尚無正式核定正文。
- `cloudflare/src/background-review.mjs`：已有 Queue 原型，但現有任務/模型工作恢復規則尚不足以支援已核定 ADR 的費用安全保護。
- `cloudflare/src/models.mjs`、`manual.mjs`、`guardrails.mjs`：原有雙模型、手動貼回與付費呼叫計數護欄沿用。
- `.github/workflows/test.yml`：`push`／`pull_request` 時只執行本機 Node/Python 驗證，**不包含 staging 部署**；`deploy-staging.yml` 另外要求明確 workflow_dispatch 和環境變數。

Phase 0 為靜態檢查＋現有 GitHub CI 回歸，不代表已執行雲端部署或建立真實模型連線。

## 2. Phase 1：新增四份累進 migration

| Migration | 新增資料結構／重要保護 | 驗收 |
| --- | --- | --- |
| `0007_human_finals.sql` | 通用／國考模板 `template_key`、`human_drafts` revision、`final_versions` 多版本；定稿 immutable trigger、同任務版本鏈及禁止刪除含核定資料的任務 | 通過 |
| `0008_objections.sql` | `ai_output_metadata`、`critique_parse_status`、`review_objections`、`objection_events`、`objection_relations`；AI 原文與原始異議不可覆寫、跨回合異議檢查 | 通過 |
| `0009_source_checks.sql` | `source_checks`、`source_check_events`；已核對僅能標註 human、跨任務引用保護；定稿快照仍由 `final_versions.source_snapshot_json` 保存 | 通過 |
| `0010_review_jobs.sql` | `review_jobs`、`review_model_attempts`、`retry_authorizations`、`queue_outbox`、`mutation_idempotency`；`persisted` 必須對應實際 AI 輸出、已持久化狀態禁止倒退 | 通過 |

以上 SQL migration 已加入儲存庫，**僅建立資料層基礎，不會啟動 Queues、模型呼叫、自動重試或新 API 功能**。原始 `0001`–`0006` 未被修改。

## 3. 新增與執行的測試

- 新增 `cloudflare/test/check_schema_v1.py`，先以既有 0001–0006 建立歷史樣本（含 manual 模式、AI 原文、人類決策），再套用 0007–0010，確認舊紀錄不變。
- 測試不可覆寫 v1、v2 核定版本、同任務版本關聯、跨任務參照拒絕、草稿原子 CAS（過期 revision 更新失敗）。
- 測試異議及原始模型輸出 immutable、人工異議修訂事件留痕、來源查證要求人類、核定快照不隨後續來源狀態改寫。
- 測試模型工作 round 正確歸屬、已持久化輸出不能倒退、沒有輸出不可標記 persisted、人工重試票據唯一。
- 修改 `.github/workflows/test.yml`，追加執行 `python3 cloudflare/test/check_schema_v1.py`。

**實際 GitHub Actions 成功紀錄**：
- URL：<https://github.com/LeoKYChen/multi-ai-review-desk/actions/runs/39613350561>
- 驗證 commit：`6892f731ce3b0efffae97dd9cc6bfe852071b689`
- Node Workers 單元測試：65 通過、0 失敗
- Offline HTML 回歸：8 通過、0 失敗
- Offline 資料轉換：7 通過、0 失敗
- `tools/test/sqlite-dry-run.py`：PASS
- `cloudflare/test/check_schema.py`：PASS
- **`cloudflare/test/check_schema_v1.py`：7 組 PASS**（migration 相容、核定不可覆寫、CAS、異議、來源、模型嘗試、總結）
- Browser JavaScript 語法驗證：成功
- 整體工作：**Success**

此為 CI 的真實執行結果，不是設計上「預計會通過」。

## 4. 已知限制與後續依賴

**明確尚未完成（不得標為已通過）**：
- 0010 增設的資料表尚未與既有 Worker/Queue 連接；只是防護性、惰性的資料層，不能證明付費 API 有完整 exactly-once 語義。
- 新草稿、核定、異議、查證與安全 retry API 尚未實作；舊人工核定端點仍具舊行為，正式上線前須避免直接 closed 而未產生 `final_versions`。
- 結構化異議與其原句文字定位的實際抽取／驗證演算法尚未實作。
- 跨裝置離線編輯、瀏覽器暫存／清除、完整多版本 Markdown 匯出尚未實作。
- 尚無 Cloudflare Remote D1 migration、Queue E2E、Cloudflare Access 驗收、雙模型真實授權、付費模型實呼叫或正式站；用本機成功取代真實環境驗收是不正確的。
- SQLite schema 約束不是完整的商業授權檢查。模型實際費用、工作租約、原子性、跨表驗證等必要的 API/Worker 規則依 `docs/WORKFLOW.md` 在 Phase 2+ 才實作。
- `docs/DATA_MODEL.md` 是先前審定的工程規格；本次 migration 有部分更嚴格的 CHECK/trigger。以已提交 SQL、成功的測試、20 項 ADR 為依據，若未來有差異需在開發 PR 內明確註記。

## 5. 下一步／需重新授權

Phase 0 與 Phase 1 已完成並在 GitHub CI 通過。依 `docs/IMPLEMENTATION_PLAN.md`，**下一步才是 Phase 2：安全 Queue 工作引擎與模型執行持久化狀態**。

本次同意範圍僅 Phase 0／Phase 1，故**停在此處，不自動進入 Phase 2**。後續若授權 Phase 2，亦先透過 fake provider／fake Queue 做本機實作和失敗注入；任何真實 Cloudflare、API Key、Token、登入、付費模型、部署或遠端 D1 動作，仍需本人另行明確授權。
