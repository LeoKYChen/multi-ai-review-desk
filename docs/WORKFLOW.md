# WORKFLOW｜Feedback Desk v1.0 審查、恢復與人工核定狀態機

- 狀態：Proposed／供 Codex 實作；本文件中的新狀態不是目前程式已實作的功能
- 依據：[ADR.md](ADR.md)、[DATA_MODEL.md](DATA_MODEL.md)、[API_SPEC.md](API_SPEC.md)
- 核心不變條件：兩模型初評隔離、先兩份完整再互審；任一模型失敗暫停；只有本人核定；任何定稿編輯不自動產生模型費用

## 1. 四個互不混淆的層次

1. **任務（tasks.status）**：現有 new／running／awaiting_human／needs_rework／closed／failed。不要僅依 running 斷定模型仍在正常執行。
2. **回合（task_rounds.state）**：一輪兩 AI 三階段進度，容許同一任務有不同 round，原始結果不可覆寫。
3. **工作（review_jobs.state）**：queued／running／paused_failure／paused_parse／awaiting_human／completed；以 job state 呈現真正的停機與恢復狀態，避免為了加 paused 直接破壞 tasks 的 SQLite CHECK。
4. **模型嘗試（review_model_attempts.state）**：reserved／request_started／response_received／persisted／definite_pre_dispatch_failure／outcome_unknown；模型已產生文字、資料庫已入庫、provider 是否可能已計費，必須分開。

## 2. 雲端模式的標準路徑

~~~text
任務 new
  │ 本人明確按「開始雙 AI 審查」、設定與額度合法
  ▼
建立 round / job queued，持久化 queue_outbox
  │ 安全排程 Queue 消息（只含 job UUID）
  ▼
Phase 1 independent:
  ├─ OpenAI：僅見原始交辦、同一回合以外允許的人類退回理由
  └─ Gemini：僅見相同原始交辦，不得見 OpenAI 本回合初評
  │ 兩份文字保存成功 + 資料完整
  ▼
Phase 2 critique:
  ├─ OpenAI：讀雙方原始初評，提出具體異議及自己反省
  └─ Gemini：讀雙方原始初評，提出具體異議及自己反省
  │ 兩份 critique 原始文字皆保存；結構化異議可解析或經本人整理
  ▼
Phase 3 proposal:
  ├─ OpenAI：讀原始初評、交叉異議、已可用的結構化整理
  └─ Gemini：讀同一資料，獨立給出個別修正建議
  │ 兩份 proposal 成功持久化
  ▼
awaiting_human
  ├─ 本人自行整理、修正異議／來源
  ├─ 人工草稿自動保存，斷網轉本機暫存
  ├─ 人工核定 → final_versions v1 → closed
  └─ 退回重議（帶具體理由）→ 下一個 round，需明確授權重新執行 AI
~~~

**標準回合六份 AI 原文**；若其中一個階段失敗，不得宣稱已完成六份或已完成兩模型互審。可保留一部分成功輸出，但流程停止。模型無異議是合法結果（objections 空清單），與模型無法解析結果不同。

## 3. 門檻與狀態轉換表

| 當前狀態／階段 | 事件 | 必須滿足 | 下一步 |
| --- | --- | --- | --- |
| new | 本人開始 API 任務 | 身分、API 授權旗標、Queue 綁定、成本額度 | round/job queued |
| queued | Queue 交付 | 冪等檢查、job 租約與版本一致 | running independent |
| independent | 僅一份成功持久化 | 另一份尚未完成 | 同階段執行另一方（不是下一階段） |
| independent | 任一方明確失敗或結果未知 | 留下已保存輸出、執行嘗試紀錄 | paused_failure，等本人 |
| independent | 雙方均已持久化 | 輸出 id 唯一；原稿不變 | critique |
| critique | 雙方原文已入庫，但任何必要結構解析失敗 | parse_status=needs_human | paused_parse，等本人整理 |
| critique | 雙方原文且必要結構有效／人工補正 | 原始輸出不修改；可引用目標輸出 ID | proposal |
| proposal | 任一方失敗 | 記錄錯誤且不覆寫舊輸出 | paused_failure |
| proposal | 雙方持久化 | 三階段均完成、無解析阻礙 | awaiting_human |
| awaiting_human | 本人寫草稿 | CAS 與本機同步規則 | 草稿 revision +1；不呼叫模型 |
| awaiting_human | 本人核定 | 草稿 revision 最新、未查證警示確認 | 原子新增 final_versions；closed |
| closed | 本人修訂定稿 | 以已核定 vN 作為草稿基礎 | final_versions vN+1；保持 closed、不重新跑模型 |
| closed／awaiting_human | 本人要求重新雙 AI 審查 | 額外明確授權、風險／成本檢查 | 新 round，絕不覆寫舊 round |
| paused_failure | 本人確認風險後重試缺漏 | 重試票據、冪等、保存成果核對 | queued/同階段，僅缺漏者 |
| paused_parse | 本人完成有效異議整理 | parse status=resolved、必要關聯有效 | 安全進入 proposal，無需再次呼叫 critique |
| 任意 | 未登入嘗試寫入 | 無授權 | 拒絕；狀態不變 |

**模型回覆與人工結果不得混為一談**：proposal 僅表示模型提出修正，不能讓 job 或 task 在未經本人核定的情況下直接變 closed。

## 4. 異議解析與人工調整

模型先輸出正常可閱讀全文，再用可驗證的結構化欄位傳遞異議。每項異議包含：
- 誰提出、對哪個 ai_outputs.id、對哪個具體句／段落、原文引句、反對理由；
- 原文定位可驗證才記 sentence／paragraph，否則顯示 whole 與待人工確認，不得憑猜測產生 offset；
- AI 原始 critique 不能由人的修正功能修改；
- 本人可以校正、增加、合併、拆分異議，產生 event 與 lineage；
- 如果連必要資料都缺失或結構不可解析，標記 needs_human；保存整份原文，停止後續階段，直到本人整理並確認。

例外：模型確實表達「沒有異議」，且輸出結構合法，可以保留空異議陣列，不必無故暫停。

## 5. Queue 並發、租約與模型費用防護

**原則：D1 寫入與外部模型 API 呼叫不能做成跨服務的單一交易**，因此不能保證第三方服務 exactly-once 計費。可保證的是本系統不**主動**對不確定結果盲目再呼叫。

1. 每筆工作先持久化 job 與 queue_outbox 待發命令，後送只含 job UUID 的 Queue 訊息；如果 DB 已提交但 Queue send 失敗，安全 reconciler 重新送**控制訊息**，不等於重新呼叫模型。
2. Consumer 每次讀當前 DB 真相並取得條件式 job/attempt 租約，檢查該 round/provider/phase 是否已存 ai_outputs 及是否存在 outcome_unknown；只有完全安全才可執行。
3. 呼叫模型前記錄 request_started；接收回覆後記 response_received；持久化 ai_outputs 與 persisted 狀態盡可能同一 DB transaction。
4. 逾時／crash 出現在 request_started 之後但 persisted 之前，標 outcome_unknown 並 paused_failure，不重新自動呼叫。
5. 遇到成功輸出已存在的重送消息，只回覆既有狀態，不再呼叫 provider；並行 consumer 或 Queue 重送不能繞過唯一鍵及防重複邏輯。
6. 需要付費模型的人工 retry：先由 GET recovery 顯示各模型階段已有結果、未知是否計費、剩餘嘗試額度；本人明確確認可能收費，再 POST retry，以 idempotency key 取得單次授權；同 key 連點不產生新的 provider 呼叫。
7. 缺少模型金鑰、Queue binding、或 MODEL_API_ENABLED/BACKGROUND_JOBS_ENABLED 為 false 時，只回明確未授權狀態，不偽造 AI 回覆、不偷偷改任務為成功。
8. 模型已計費但無結果時，無法憑 D1 推斷實際帳單；UI 使用「可能重複計費」而非「必然已計費」。依 Cloudflare 或供應商當時實際限制驗收再調整 timeout／batch。
9. 任一模型回覆成功但輸出保存失敗時，必須停止本階段，不可先執行下一 phase；若主控台出現 run_lock_until 過期而未實際完成，不應把其視為安全自動重跑模型的許可。

## 6. 人工草稿與已核定版本

~~~text
從當前 AI 意見／前一份核定版本建立人工草稿
   │
   ├─ 線上：使用 expected_revision CAS 自動保存
   │           ├─ 成功 → 雲端已同步 → 刪除此 local_edit_id 對應暫存
   │           └─ 409  → 本機保留 → 顯示雲端版與本機版供比對
   │
   └─ 斷線：本機暫存（標記未同步；不可誤稱已上傳）
               └─ 復線先讀雲端 revision，再同步／比較
   │
   ▼
本人確認草稿內容與核定時待查證警示
   │
   ▼
以交易新增 final_versions vN，來源快照為核定當下狀態
   │
   ├─ 日後更新查證：只修改目前 source_checks（留事件），不改 vN
   ├─ 人工更正：建立新草稿 → final_versions vN+1，不呼叫 AI
   └─ 若有需要再次互審：另按「重新進行雙 AI 審查」，產生新 round
~~~

- 只有本人能核定；已核定正文沒有修改或刪除 API；
- 核定時來源與驗證狀態的快照，應隨該版定稿一併保存；最新驗證狀態另行讀取。
- 存在 pending／model_inference 的事項時顯示警示，但核定不強制先查完；需本人確實確認警示，最終匯出保留未核實的清單。
- 本機暫存應有清除入口與隱私警示；不包含 API token/密碼；同步失敗或版本衝突時不可刪除。
- 新增 v2 定稿並非 v1 的覆寫，也不應修改 v1 的來源快照、時間或審查紀錄。

## 7. 手動網頁模式與通用模板

- manual 模式保留現有「由本人貼到 ChatGPT/Gemini 網頁再把回覆貼回」六階段過程；系統不能假裝已在背景自動操作網頁帳號。
- 手動貼回必須標記 manual_unverified；人工異議解析補正與人工定稿一致，不能冒稱模型身份已驗證。
- template_key=general 是通用模式；exam_essay 僅加上國考題源、配分、爭點與示範段落的可選輔助規則，不能使通用題目被迫填考科。
- 法規或研究引用皆依 source_checks 標示 verified/pending/model_inference，禁止模型共同主張就自動驗證。

## 8. 人工可見的 UI 文案最低要求

- 「兩份獨立初評已完成」、「交叉意見待整理」、「雙 AI 修正建議已完成，等待你核定」；
- 「Gemini 執行失敗，ChatGPT 已完成的結果已保留」，不是「已完成」；
- 「可能已計費但結果未保存，需要你決定是否重新呼叫」；
- 「本機已保存，尚未同步」、「雲端已保存」、「版本衝突，未覆寫雲端」；
- 「核定版本 v1（2026-… 當時待查證 2 項）」、「最新查證結果已更新」；
- 完成按鈕只在建立正式 final_versions 之後顯示為已由本人結案。

## 9. 必須模擬的故障注入場景

- Provider 連線失敗前未送出請求；provider 已接受但 Worker timeout；成功收到文字卻 D1 INSERT 失敗。
- Queue send 已失敗但 DB 標成待派；Queue 重送；job 鎖過期、兩 consumer 同時獲訊。
- critique 回覆有文字但 JSON 不合格式；人工修復；雙模型無異議。
- 手機／電腦以同 revision 存草稿；復線後舊 ACK 到達較新的本機草稿；核定 v1/v2。
- 核定 pending 事項後查證變 verified；v1 快照保持 pending。
- 任何失敗分支不應插入 fake output、覆寫 AI 原文、產生自動付費重試或自動人工核定。

完整 Given/When/Then 測試與上線門檻見 [TEST_PLAN.md](TEST_PLAN.md)。