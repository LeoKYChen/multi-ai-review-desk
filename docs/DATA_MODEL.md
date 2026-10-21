# DATA_MODEL｜Feedback Desk v1.0 D1 資料模型與遷移規格

- 狀態：工程實作規格（Proposed；依 ADR-001～020，不代表 migration 已建立）
- 基準：開發分支 feat/d1-docx-review-v020；現有 cloudflare/migrations/0001_init.sql 至 0006_background_queue.sql
- 目標：只增加新 migration，不重新建立資料庫、不刪除既有資料、不覆寫 AI 原文與人類已核定版本
- 對照文件：[ADR.md](ADR.md)／[API_SPEC.md](API_SPEC.md)／[WORKFLOW.md](WORKFLOW.md)

## 1. 既有資料庫基線（以實際程式核對）

| 表／欄位 | 現況 | 相容性約束 |
| --- | --- | --- |
| tasks | id、title、instruction、document_text、document_name、status、created_at、updated_at；後續增加 mode、category、run_lock_until、queue_requested | 原文 UPDATE 有防覆寫 trigger；不得變更舊欄位語意 |
| task_rounds | 每任務序號 UNIQUE(task_id, ordinal) | 既有狀態 running／awaiting_human／failed／closed／needs_rework |
| ai_outputs | 唯一 (round_id, provider, phase)，保存原始 body、created_at，後續有 source | provider 為 chatgpt、gemini；phase 為 independent、critique、proposal；手動貼入標記 manual_unverified |
| human_decisions | UNIQUE(round_id)，decision＋note＋created_at | 不能拿既有單次決策欄位充當多版正式定稿 |
| model_call_attempts | reserved／succeeded／failed | 歷史紀錄不包含是否成功持久化，不能當作新工作「已付費與否」的權威依據 |
| tasks.queue_requested | 0／1 | 不是完整工作狀態或送達保證 |

**禁止**直接修改已可能套用的 0001–0006 migration。全部新功能以 0007 以後的檔案、相容讀取與切換程式完成。即使遠端尚未部署，也先依累進遷移處理。

## 2. 資料實體與關聯

~~~text
tasks (1) ── (N) task_rounds (1) ── (N) ai_outputs
  │                    │                   │
  │                    │                   └── ai_output_metadata
  │                    ├── review_jobs ── review_model_attempts
  │                    │       ├── retry_authorizations
  │                    │       └── queue_outbox
  │                    └── review_objections ── objection_events
  │                                              └── objection_relations
  ├── human_drafts (0..1 active draft per task)
  ├── final_versions (0..N; immutable; revision chain)
  └── source_checks ── source_check_events

final_versions.source_snapshot_json = fixed verification snapshot at approval
~~~

資料身份隔離：task_id 與 round_id 必須跨查詢同時檢查，不能用別人的 output_id、source_check_id 或 final_id 混入其他任務。所有識別碼使用伺服器生成 UUID。時間一律存 ISO 8601 UTC，呈現時才轉使用者時區。

## 3. 累進 migration 設計（供 Codex 建成實際 SQL）

### 0007：人工草稿、定稿與模板

建議新增：

~~~sql
ALTER TABLE tasks ADD COLUMN template_key TEXT NOT NULL DEFAULT 'general'
  CHECK(template_key IN ('general','exam_essay'));

CREATE TABLE final_versions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  version_no INTEGER NOT NULL CHECK(version_no > 0),
  parent_version_id TEXT REFERENCES final_versions(id) ON DELETE RESTRICT,
  review_round_id TEXT REFERENCES task_rounds(id) ON DELETE RESTRICT,
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 100000),
  decision TEXT NOT NULL CHECK(decision IN
    ('accept_chatgpt','accept_gemini','partial','reject','manual_revision')),
  note TEXT NOT NULL DEFAULT '',
  source_snapshot_json TEXT NOT NULL CHECK(json_valid(source_snapshot_json)),
  approved_at TEXT NOT NULL,
  UNIQUE(task_id,version_no)
);
CREATE INDEX idx_final_versions_task ON final_versions(task_id,version_no DESC);

CREATE TABLE human_drafts (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE RESTRICT,
  base_final_id TEXT REFERENCES final_versions(id) ON DELETE RESTRICT,
  body TEXT NOT NULL DEFAULT '' CHECK(length(body) <= 100000),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  updated_at TEXT NOT NULL
);


CREATE TRIGGER final_no_update BEFORE UPDATE ON final_versions
BEGIN SELECT RAISE(ABORT,'FINAL_VERSION_IMMUTABLE'); END;
CREATE TRIGGER final_no_delete BEFORE DELETE ON final_versions
BEGIN SELECT RAISE(ABORT,'FINAL_VERSION_IMMUTABLE'); END;
CREATE TRIGGER prevent_final_task_delete BEFORE DELETE ON tasks
WHEN EXISTS(SELECT 1 FROM final_versions WHERE task_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'TASK_WITH_FINAL_IMMUTABLE'); END;
~~~

**遷移順序注意**：先建立 final_versions，再建立引用它的 human_drafts。需用 D1/SQLite 本機遷移測試確認外鍵與 trigger；正式版對已核定任務只允許封存（archive），不提供永久刪除。

人工草稿使用原子 CAS：
~~~sql
UPDATE human_drafts
SET body = ?, revision = revision + 1, updated_at = ?
WHERE task_id = ? AND revision = ?;
~~~
changes=0 時回應版本衝突，不得覆寫；首次建立草稿需以唯一 task_id 插入並妥善處理競爭，不能以未驗證的 UPSERT 覆寫已存在內容。核定時比對 expected_revision，於單一交易內新增 final_versions（version_no = MAX + 1）、保存查證快照、必要時記錄人類審查決定及 task 狀態；交易失敗須無部分核定。當 closed 任務純人工新修訂，建立新 final version **不自動重跑 AI**，亦不強行新增 task_rounds 或重複插入 UNIQUE(round_id) 的 human_decisions。

### 0008：結構化異議與人工修訂軌跡

~~~sql
CREATE TABLE ai_output_metadata (
  ai_output_id TEXT PRIMARY KEY REFERENCES ai_outputs(id) ON DELETE RESTRICT,
  provider_model_id TEXT,
  prompt_version TEXT,
  prompt_sha256 TEXT,
  input_sha256 TEXT,
  finish_reason TEXT,
  token_usage_json TEXT CHECK(token_usage_json IS NULL OR json_valid(token_usage_json)),
  captured_at TEXT NOT NULL
);
CREATE TABLE critique_parse_status (
  ai_output_id TEXT PRIMARY KEY REFERENCES ai_outputs(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('valid','needs_human','resolved')),
  error_code TEXT,
  checked_at TEXT NOT NULL
);
CREATE TABLE review_objections (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES task_rounds(id) ON DELETE RESTRICT,
  source_critique_output_id TEXT REFERENCES ai_outputs(id) ON DELETE RESTRICT,
  target_output_id TEXT REFERENCES ai_outputs(id) ON DELETE RESTRICT,
  origin TEXT NOT NULL CHECK(origin IN ('ai','human')),
  anchor_kind TEXT NOT NULL CHECK(anchor_kind IN ('sentence','paragraph','whole')),
  quoted_text TEXT NOT NULL DEFAULT '',
  start_offset INTEGER,
  end_offset INTEGER,
  objection_text TEXT NOT NULL CHECK(length(objection_text)>0),
  created_at TEXT NOT NULL,
  CHECK((start_offset IS NULL AND end_offset IS NULL) OR
        (start_offset >= 0 AND end_offset > start_offset))
);
CREATE INDEX idx_objections_round ON review_objections(round_id,created_at);
CREATE TABLE objection_events (
  id TEXT PRIMARY KEY,
  objection_id TEXT NOT NULL REFERENCES review_objections(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN
    ('create','correct','merge','split','annotate','resolve')),
  actor TEXT NOT NULL CHECK(actor IN ('human','system')),
  prior_revision INTEGER NOT NULL,
  next_revision INTEGER NOT NULL,
  details_json TEXT NOT NULL CHECK(json_valid(details_json)),
  created_at TEXT NOT NULL,
  UNIQUE(objection_id,next_revision)
);
CREATE TABLE objection_relations (
  parent_objection_id TEXT NOT NULL REFERENCES review_objections(id) ON DELETE RESTRICT,
  child_objection_id TEXT NOT NULL REFERENCES review_objections(id) ON DELETE RESTRICT,
  relation TEXT NOT NULL CHECK(relation IN ('merge','split','derived')),
  PRIMARY KEY(parent_objection_id,child_objection_id,relation),
  CHECK(parent_objection_id <> child_objection_id)
);
~~~

異議來源及 target_output_id 必須屬於同一 review round；此跨表驗證需在 API 層或 SQL trigger 補上。AI 原文不可改寫；對已建 objection 的人工整理記成事件／衍生關係，由程式組成目前有效視圖。若解析失敗，先保存原始 ai_outputs.body，再寫 critique_parse_status=needs_human；需要結構化異議時立即暫停，待人工確認／補正成 resolved 才續行。

### 0009：來源、查證及核定時間快照

~~~sql
CREATE TABLE source_checks (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  related_ai_output_id TEXT REFERENCES ai_outputs(id) ON DELETE RESTRICT,
  related_objection_id TEXT REFERENCES review_objections(id) ON DELETE RESTRICT,
  claim_text TEXT NOT NULL CHECK(length(claim_text)>0),
  source_label TEXT NOT NULL DEFAULT '',
  source_uri TEXT,
  source_locator TEXT,
  status TEXT NOT NULL CHECK(status IN
    ('verified','pending','model_inference')),
  verified_by TEXT,
  verified_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  CHECK(status <> 'verified' OR
    (verified_by IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE INDEX idx_source_task_status ON source_checks(task_id,status);
CREATE TABLE source_check_events (
  id TEXT PRIMARY KEY,
  source_check_id TEXT NOT NULL REFERENCES source_checks(id) ON DELETE RESTRICT,
  previous_status TEXT,
  new_status TEXT NOT NULL CHECK(new_status IN
    ('verified','pending','model_inference')),
  actor TEXT NOT NULL CHECK(actor IN ('human','system')),
  evidence_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
~~~

核定時以 JSON **深拷貝**完整來源清單到 final_versions.source_snapshot_json（包含主張、來源、核定當時狀態、核對人／時間）。舊版快照永久不變，最新狀態則另外查 source_checks 並顯示「目前」。模型聲稱引用不等於 verified；只有本人親自核對才可標記 verified。不存在來源亦允許 pending 或 model_inference（不得假裝已核對）。

### 0010：Queue 工作、模型執行嘗試與明確重試

~~~sql
CREATE TABLE review_jobs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  round_id TEXT NOT NULL UNIQUE REFERENCES task_rounds(id) ON DELETE RESTRICT,
  phase TEXT NOT NULL CHECK(phase IN ('independent','critique','proposal')),
  state TEXT NOT NULL CHECK(state IN
    ('queued','running','paused_failure','paused_parse',
     'awaiting_human','completed')),
  lease_until INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  reason_code TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_state ON review_jobs(state,updated_at);

CREATE TABLE review_model_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES review_jobs(id) ON DELETE RESTRICT,
  round_id TEXT NOT NULL REFERENCES task_rounds(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK(provider IN ('chatgpt','gemini')),
  phase TEXT NOT NULL CHECK(phase IN ('independent','critique','proposal')),
  attempt_no INTEGER NOT NULL CHECK(attempt_no>0),
  state TEXT NOT NULL CHECK(state IN
    ('reserved','request_started','response_received',
     'persisted','definite_pre_dispatch_failure','outcome_unknown')),
  provider_request_id TEXT,
  ai_output_id TEXT UNIQUE REFERENCES ai_outputs(id) ON DELETE RESTRICT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(round_id,provider,phase,attempt_no)
);
CREATE INDEX idx_model_attempts_round ON review_model_attempts(round_id,provider,phase);

CREATE TABLE retry_authorizations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES review_jobs(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK(provider IN ('chatgpt','gemini')),
  phase TEXT NOT NULL CHECK(phase IN ('independent','critique','proposal')),
  risk_ack INTEGER NOT NULL CHECK(risk_ack=1),
  reason TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  granted_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE queue_outbox (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES review_jobs(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','sent','processed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_queue_outbox_pending ON queue_outbox(state,created_at);

CREATE TABLE mutation_idempotency (
  scope TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(scope,request_key)
);
~~~

**限制與實作義務**：

1. 現有 model_call_attempts 用於舊有計數護欄；新 review_model_attempts 是更精細的執行狀態，不得自行把舊的 succeeded 當 persisted。設計必須確保模型計數在併發下原子保留；前一次結果未知時不得自動呼叫模型。
2. 每個請求的「取得模型回覆」、「寫入 ai_outputs」、「標記 persisted」要能被可靠識別；後兩者盡可能在同一 D1 transaction/batch 完成。持久化確認前的進程中斷視為 outcome_unknown（需要人審），不可隱性重試。
3. D1 寫入 queue_outbox 與外部 Queue send 並非同一交易；需以 outbox + 安全 reconciler 重投**不涉及再呼叫模型的控制訊息**，並在 consumer 逐次驗證 job、phase、已入庫輸出與 attempt 才決定是否執行，避免「DB 設 queued 但訊息沒送出」永久卡住。
4. Queue payload **只含不敏感 job UUID**，不包含題目原文、密碼、token 或完整模型回覆。
5. 任何回復／重試都必須先檢查現有 ai_outputs 唯一鍵、尚未完成的 provider/phase、最新授權及可用費用上限。因 API Provider 並非必然有跨供應商 exactly-once 的語義，不能承諾絕無重複計費。
6. 同樣須檢查歷次舊資料、停用背景工作、並發與排程延遲情況。長時間執行時租約失效不得讓另一 consumer 自動二次呼叫不確定的模型工作。

## 4. 權限、刪除政策與資料安全

- 所有讀取／寫入任務內容的端點僅限本人登入；正式上線另需 Cloudflare Access 只允許本人。不得把 OWNER_TOKEN／模型 key 放前端、GitHub、匯出檔、日誌、URL。
- task 指示與附件內容視為不可信資料；不得執行其中的 shell、URL 或工具指令。
- final_versions、ai_outputs 原文、原始異議與事件採 append-only；若需刪除私人資料須先另行制定保全與刪除政策（v1.0 不提供對已核定資料的永久刪除 UI）。
- 本機 IndexedDB 等暫存不等於遠端備份，瀏覽器本地資料可能被同裝置使用者讀取；同步成功只清除**已確認對應 revision**，衝突時保留並提示。不要設計默默從離線覆寫雲端。
- Word 原檔不永久保存，只擷取正文文字；圖表、註解、圖片、頁首頁尾等可能遺失，必須保留警告。禁用可識別少年個案、非公開卷證與公務機密作為測試資料。

## 5. Migration 實施順序與 rollback

1. 使用既有測試 fixture 建立全新本機 SQLite/D1，先套用 **0001–0006**，確認基線；
2. 按 **0007 → 0008 → 0009 → 0010** 套用新 migration，實際 SQL 以本文件規格落地；以 PR 審查，先建表再開功能旗標；
3. 每項 migration 檢查 PRAGMA foreign_key_check、index、trigger 及舊資料可查詢；測試重複套用時要由 migration runner 追蹤，禁止重複破壞；
4. 編寫 API 與前端時保持舊任務相容；新版核定端點啟用前，不得讓舊 POST /api/tasks/:id/review 繞過新 immutable final 保存機制；
5. **只對隔離測試庫**演練備份與完整還原；正式庫資料遷移或資料庫回復需另取得授權；
6. SQLite/D1 migration 通常不可簡單回滾 DROP TABLE；出錯時停止發布、保留備份，採補充 migration 修正，不能隨意破壞性回退。

## 6. 資料層驗收門檻

- DM-01：舊任務的原始指示／Word 擷取文字、AI 輸出、人工決定查詢前後一致。
- DM-02：同任務可有定稿 v1/v2；v1 UPDATE/DELETE 一律遭拒。
- DM-03：兩裝置以相同 revision 更新草稿，只有一筆成功，另一筆 409 並可比較。
- DM-04：異議原句引用與 target_output_id 可回溯；人工合併／拆分保留 lineage 及所有原文。
- DM-05：異議解析失敗保留 AI 回答、停機待人工，修正後只繼續安全階段。
- DM-06：模型已回應、DB 尚未存入時不得記 persisted 或自動重試付費呼叫。
- DM-07：核定當下 pending 快照與未來 verified 現況並存，不改過去快照。
- DM-08：Queue 重送、人工重試連點及同時 consumer 不能產生重複的同階段成功輸出。
- DM-09：本地離線同步成功清除正確的暫存項；斷線或 409 時保留未同步內容。

對應詳細驗收案例見 [TEST_PLAN.md](TEST_PLAN.md)。