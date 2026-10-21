# API_SPEC｜Feedback Desk v1.0 Workers HTTP API 契約

- 狀態：Proposed／待 Codex 實作與 mock 驗收；此文件不是現有 API 已提供的保證
- 決策來源：[ADR.md](ADR.md) ADR-001～020
- 資料來源：[DATA_MODEL.md](DATA_MODEL.md)
- 前提：私人單人站、Cloudflare Workers + D1 + Queue、雙模型初評／互審／修正、人工定稿
- 請求中「chatgpt」為 UI 標籤，實際供應商 OpenAI API 的 model ID 應另存；Gemini 亦然

## 1. 現有路由與需保持的行為

已存在（詳 cloudflare/src/worker.mjs）：

| Method | Path | 現有用途 |
| --- | --- | --- |
| POST | /api/login | OWNER_PASSWORD 登入；Cookie |
| GET | /api/session | 登入狀態 |
| POST | /api/logout | 清除登入 Cookie |
| GET | /api/settings | 僅回傳模型配置狀態、模型呼叫嘗試次數上限 |
| POST | /api/tasks | multipart/form-data，文字或 .docx 建任務；有 manual/api 模式與 category |
| GET | /api/tasks | 搜尋、分類、狀態過濾 |
| GET | /api/tasks/:id | 任務與各輪輸出及 human_decisions |
| POST | /api/tasks/:id/advance | 模型 API 下一階段；啟用背景旗標才排 Queue |
| POST | /api/tasks/:id/manual-begin | 手動網頁版輔助模式開始 |
| GET | /api/tasks/:id/manual-next | 生成下一份需手動轉貼的提示詞 |
| POST | /api/tasks/:id/manual-output | 貼回一份結果，source=manual_unverified |
| POST | /api/tasks/:id/review | 舊人工採納／退回 API；可能直接將狀態設 closed |
| GET | /api/tasks/:id/export.md | 匯出原始文字、AI 意見與舊人工決定 |

**關鍵相容策略**：保留人工退回重議用途，但在新核定功能開啟時，舊 /review 端點的非 rework 路徑**必須導向新核定交易，或明確拒絕並要求使用新 /finals**；不可留下可以直接 closed 卻沒有 final_versions 的繞過路徑。任何既有舊資料保留原有 decision/note 顯示，不虛構正式定稿。

## 2. 跨端點一致的安全、格式與錯誤契約

- 唯一本人登入、Cloudflare Access 私人存取作額外網路邊界；所有 /api/tasks/*、草稿、異議、核定、匯出、重試路由都需驗證登入。API Keys 僅存在 Workers Secrets；不得前端取用。
- Cookie 使用 HttpOnly/Secure/SameSite；寫入 API 必須有同源/CSRF 驗證。瀏覽器使用 Cookie，不能以未驗證的 client-provided is_human 旗標授權。HTTP GET 不觸發付費、核定或資料修改。
- Content-Type：一般 JSON 用 application/json；建立任務用 multipart/form-data；匯出用 text/markdown，且 Cache-Control: no-store。
- 日期 UTC ISO 8601；text/user fields 有服務端長度限制；task_id、round_id、idempotency_key 嚴格驗證。歷史內容與模型評論均視為不可信資料。
- 寫入成功 200/201；Queue 已排程 202；未認證 401；沒權限 403；不存在 404；衝突 409；不合規輸入 422；成本／速率上限 429；設定未啟用 503 或業務化的 409，需整體一致；非預期錯誤 500 不洩漏 stack/金鑰。
- 409/422 的標準回應：

~~~json
{
  "error": {
    "code": "DRAFT_VERSION_CONFLICT",
    "message": "草稿版本已更新，請先比較兩份內容",
    "request_id": "server-generated-id",
    "details": {
      "server_revision": 8,
      "server_body": "新的雲端草稿文字"
    }
  }
}
~~~

避免使用 HTTP 200 包裝實際失敗；API 錯誤清單與前端中文訊息要有版本化測試。回應不可顯示模型 Secrets、Authorization 標頭、帳密或私人服務設定。

## 3. 任務、模板與讀取

### POST /api/tasks（原路由擴充）

multipart/form-data：
- title：1～180 字元（現有）；
- instruction：必要、1～20,000 字元（現有）；
- document：可選 .docx、上限 3 MiB；擷取文字上限 50,000 字元（現有）；正文可能不含圖片、註解、頁首頁尾；
- mode：manual 或 api（現有）；沒有模型授權時不能以 api 模式假裝已運行；
- category：可選通用分類（現有）；
- template_key：general（預設）或 exam_essay（建議新欄位），僅 exam_essay 顯示專屬題源／配分，v1.0 不將國考欄位設為通用必填。

回 201 提供 task_id、status=new、原檔擷取警告、mode、template_key。原文寫入後不可透過一般編輯 API 覆寫。

### GET /api/tasks/:id（現有擴充）

原有輸出保持舊欄位相容，需補每份 output 的 id、source、model_id（有紀錄時）、prompt_version、parse_status；每個 round 含可追溯的 failure/paused、對應 job summary，並提供 latest_final_version_no、draft_revision、unverified_count。不要將已核定舊檔案憑空製造 final_versions。

## 4. 草稿：只做人工保存，不觸發 AI

### GET /api/tasks/:id/draft

~~~json
{
  "task_id": "task-uuid",
  "body": "目前人工草稿",
  "revision": 7,
  "base_final_id": "old-final-uuid-or-null",
  "updated_at": "2026-10-21T12:00:00.000Z"
}
~~~

### PUT /api/tasks/:id/draft

~~~json
{
  "body": "自行整理的文字",
  "expected_revision": 7
}
~~~

- 伺服器以 CAS 原子更新；成功 200 回新 revision=8、updated_at、acknowledged_revision=8。
- 若 expected_revision 已過期，409 DRAFT_VERSION_CONFLICT + 雲端最新版及修訂編號；不覆寫原文、定稿或本機草稿。
- 首次建立草稿以 expected_revision=0 設定，已存在時不能不經檢查覆寫。
- 本機暫存有 task_id、local_edit_id、base_server_revision，成功確認同一 local_edit_id／版本寫入後才清除該份暫存；新輸入文字不得因較早回應抵達就被清除。
- 使用者離線時 UI 顯示「本機已暫存／尚未同步」，與「雲端已保存」不同。IndexedDB 是建議媒介，不承諾硬體加密；資料可能被同裝置使用者存取。

## 5. 核定與歷史：人工專屬，append-only

### GET /api/tasks/:id/finals

回所有 version_no、id、parent_version_id、review_round_id、decision、approved_at、preview，正文可用 GET /api/tasks/:id/finals/:finalId 取得。版本排序以 version_no，不能按 timestamp 假設絕對順序。

### POST /api/tasks/:id/finals

Headers: Idempotency-Key（隨機、唯一；同 key 同 payload 返回相同結果，不同 payload 回 409）。

~~~json
{
  "expected_draft_revision": 8,
  "base_final_id": "previous-final-uuid-or-null",
  "decision": "partial",
  "note": "人工選擇與調整的理由",
  "acknowledge_unverified": true
}
~~~

- 不信任 client 指定的 final body：交易內從 D1 讀取且核對預期 revision，再新增 final_versions，保存 source_snapshot_json；由已登入本人觸發，且已過 AI 階段門檻（第一次核定）；已核定後純人工新版本不要求自動重跑 AI。
- 如果未查證項目存在，acknowledge_unverified=true 才能提交；否則 422 UNVERIFIED_ACK_REQUIRED；即使核定成功，pending 不得被改為 verified。
- 同任務 version_no 單調遞增；base_final_id 必須屬於此 task。核定全文不能為空，核定前若草稿已修改回 409 DRAFT_VERSION_CONFLICT；兩次同時核定不得產生重複版號。
- 首次核定若兼用舊 human_decisions，一次性寫入與 status transition 同交易；後續純人工版不在同一 round 再插 UNIQUE(round_id) 的第二筆決定。
- 成功 201：final_id、task_id、version_no、approved_at、snapshot_unverified_count、status=closed。已核定版本無 PUT/PATCH/DELETE。
- POST /api/tasks/:id/finals 不得觸發 Queue、AI API、模型計費。獨立「重新啟動雙 AI 審查」需顯式操作且受費用／旗標控制。

## 6. 異議與人工整理

### GET /api/tasks/:id/objections

~~~json
{
  "round_id": "round-uuid",
  "items": [{
    "id": "objection-uuid",
    "target_output_id": "output-uuid",
    "source_critique_output_id": "other-output-uuid",
    "anchor_kind": "sentence",
    "quoted_text": "被指出的原句",
    "start_offset": 12,
    "end_offset": 31,
    "objection_text": "異議理由",
    "origin": "ai",
    "revision": 1,
    "review_status": "pending",
    "lineage_ids": []
  }],
  "parse_status": "valid"
}
~~~

### PATCH /api/tasks/:id/objections/:objectionId

~~~json
{
  "expected_revision": 1,
  "action": "correct",
  "anchor_kind": "paragraph",
  "quoted_text": "對應的段落",
  "reason": "校正 AI 選錯的引用範圍"
}
~~~

- 僅本人可改整理視圖；完整 AI 輸出與原始異議永不覆寫。
- 合併／拆分以新增衍生記錄與 events 表示（分別用 POST /api/tasks/:id/objections/:id/merge、/split 或相容命令）；保存 source IDs、連結、修改理由與時間，避免循環 lineage。
- target_output_id 不得跨 task/round；精確引用應驗證其位於 output.body；找不到時只能降級 whole、標記待人工確認，不能聲稱成功定位。
- AI critique 已儲存但解析失敗，GET 顯示 needs_human，人工補正成功後透過 POST /api/tasks/:id/objections/resolve-parse 標記已檢查可續行。沒有足夠結構化資料不能假裝互審已完成。

## 7. 查證事項與定稿快照

### GET /api/tasks/:id/source-checks

每項至少：id、claim_text、source_label、source_uri/source_locator、status=verified|pending|model_inference、verified_by、verified_at、revision、related_ai_output_id、related_objection_id。

### POST /api/tasks/:id/source-checks、PATCH /api/tasks/:id/source-checks/:sourceId

- 由本人輸入查核狀態、依據與時間；狀態 verified 需要實際確認者及依據；模型自己標 verified 不被接受。
- PATCH 必須帶 expected_revision，成功新增 source_check_events，避免未記錄的改寫。
- 核定時 source_snapshot_json 以伺服器端一致視圖深拷貝當下狀態（空清單亦應保存 []）；核定版本 GET 必須提供 verification_at_approval 與 current_verification 兩種欄位，禁止用最新查證狀態覆寫既有核定快照。

## 8. 背景工作：安全恢復與可能計費的重試

### GET /api/tasks/:id/recovery

~~~json
{
  "task_id": "task-uuid",
  "job_id": "job-uuid",
  "status": "paused_failure",
  "current_phase": "independent",
  "persisted_outputs": [{"provider":"chatgpt","phase":"independent"}],
  "attempts": [{
    "provider":"gemini",
    "phase":"independent",
    "state":"outcome_unknown",
    "potential_additional_charge":true
  }],
  "risk_warning": "模型可能已處理並計費，但結果未安全儲存",
  "allowed_actions": ["retry_missing_after_ack"]
}
~~~

### POST /api/tasks/:id/retry

Headers: Idempotency-Key，必填。

~~~json
{
  "job_id": "job-uuid",
  "expected_job_revision": 5,
  "provider": "gemini",
  "phase": "independent",
  "acknowledge_possible_charge": true,
  "reason": "已閱讀目前結果及可能的重複計費風險"
}
~~~

- 先驗證本人登入、模型 API/背景旗標、job 狀態、同任務既有成功輸出、同階段 attempt、retry 授權、剩餘呼叫次數；待回覆視為 202 queued。
- 未確認可能費用時 422 CHARGE_ACK_REQUIRED；模型結果已保存時 409 ALREADY_PERSISTED；過期 job revision 409 JOB_VERSION_CONFLICT；相同 key/同請求應回相同授權或排程結果，不額外呼叫。
- 避免同一 reviewer 雙擊、手機／電腦同時重試而重複扣費。模型呼叫後中斷但無結果時標 outcome_unknown，絕不因 Queue retry 默默再次觸發模型。
- Queue 消息含 job UUID/控制資訊，不含敏感文稿；已送訊息與 D1 job 的 outbox 一致性由安全 reconciler 處理，不應無限制自動付費重試。
- 自動恢復只執行安全且已證明冪等的控制步驟；需要模型二次呼叫，一律走有費用確認與護欄的人工 retry。
- 任一 AI 失敗停在 paused_failure，不進行下一 phase；解析異議失敗停在 paused_parse，保留原文後由本人補正，若不需再呼叫模型，可從既有已保存結果安全續行。
- 回復後只補缺漏階段；已保存同 (round_id,provider,phase) 的 AI 輸出不可被覆寫。

## 9. 匯出與舊資料

### GET /api/tasks/:id/export.md（擴充）

匯出需包含：原始題目／交辦內容、附件擷取警告、各 AI 原文及來源、異議原始與人工整理歷程、模型名稱與提示詞版本（有資料時）、每版人工核定全文、核定當時來源快照、最新查證狀態（明確分離）、任務失敗記錄；不可匯出 API Key、登入 Session、Authorization、純內部 token。

對舊資料保持相容：
- 舊 round 未保存 formal final，顯示「歷史人類決定」，不偽造已核定正式版本。
- 舊模型 provider 回覆缺 model_id、prompt_version，顯示「未記錄」而非猜測。
- manual 模式使用者自己貼入 ChatGPT/Gemini 回覆，顯示 manual_unverified，絕不宣稱已由平台 API 驗證。

## 10. 主要錯誤碼與驗收對應

| code | HTTP | 條件 | 驗收 |
| --- | --- | --- | --- |
| DRAFT_VERSION_CONFLICT | 409 | 版本競爭衝突 | API-01、UI-02 |
| FINAL_VERSION_IMMUTABLE | 409 | 嘗試覆寫已核定版本 | DM-02、API-02 |
| UNVERIFIED_ACK_REQUIRED | 422 | 有待查證而未確認警示 | API-03 |
| AI_CRITIQUE_PARSE_PENDING | 409 | 異議未整理完成 | AI-03 |
| JOB_PAUSED | 409 | 工作已因模型失敗暫停 | AI-04 |
| CHARGE_ACK_REQUIRED | 422 | 風險未明確確認 | AI-06 |
| JOB_VERSION_CONFLICT | 409 | 重試使用過期 job revision | AI-06 |
| ALREADY_PERSISTED | 409 | 嘗試重跑已完整保存的階段 | AI-05 |
| MODEL_API_DISABLED | 409 | API 未啟用、未授權 | SEC-03 |
| MODEL_CALL_LIMIT | 429 | 次數／預算護欄 | SEC-04 |
| AUTH_REQUIRED | 401 | 未登入本人 | SEC-01 |

錯誤格式由 Codex 全站一致實作；在未有正式端到端測試之前，**不得宣稱這些新增端點已上線**。