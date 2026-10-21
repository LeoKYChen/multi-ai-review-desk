"""Phase 0/1 contract tests: apply legacy migrations, preserve old records, add 0007-0010.

SQLite in-memory only. Never connects to Cloudflare, providers or external services.
"""
from pathlib import Path
import json
import sqlite3

root = Path(__file__).resolve().parents[1]
migration_dir = root / "migrations"
files = sorted(migration_dir.glob("*.sql"))
expected = [f"{i:04d}" for i in range(1, 11)]
assert [p.name[:4] for p in files] == expected, [p.name for p in files]

db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys=ON")


def apply(paths):
    for path in paths:
        db.executescript(path.read_text(encoding="utf-8"))


def insert(sql, values=()):
    return db.execute(sql, values)


def rejects(sql, values=(), contains=None):
    try:
        db.execute(sql, values)
    except sqlite3.IntegrityError as exc:
        if contains:
            assert contains in str(exc), (str(exc), contains)
        return
    raise AssertionError("statement should be rejected: " + sql[:90])


# A legacy task, AI output and manual decision must remain exactly as inserted.
apply(files[:6])
insert("""INSERT INTO tasks(id,title,instruction,document_text,status,created_at,updated_at,mode)
          VALUES(?,?,?,?,?,?,?,?)""",
       ("task-1", "舊任務", "請檢查法律論點", "不可覆寫原稿", "closed", "t0", "t0", "manual"))
insert("""INSERT INTO tasks(id,title,instruction,document_text,status,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?)""",
       ("task-2", "另一任務", "獨立任務", "另一篇原文", "new", "t0", "t0"))
insert("INSERT INTO task_rounds(id,task_id,ordinal,state,created_at) VALUES(?,?,?,?,?)",
       ("r1", "task-1", 1, "closed", "t0"))
insert("INSERT INTO task_rounds(id,task_id,ordinal,state,created_at) VALUES(?,?,?,?,?)",
       ("r2", "task-2", 1, "running", "t0"))
for output_id, round_id, provider, phase, body in (
        ("o1", "r1", "chatgpt", "independent", "法律依據與疑義"),
        ("o2", "r1", "gemini", "critique", "對法律依據有疑義"),
        ("o3", "r2", "chatgpt", "independent", "任務二")):
    insert("INSERT INTO ai_outputs(id,round_id,provider,phase,body,created_at) VALUES(?,?,?,?,?,?)",
           (output_id, round_id, provider, phase, body, "t0"))
insert("INSERT INTO human_decisions(id,round_id,decision,note,created_at) VALUES(?,?,?,?,?)",
       ("d1", "r1", "partial", "原始人工決定", "t0"))
legacy = {
    "task": db.execute("SELECT title,instruction,document_text,status,mode FROM tasks WHERE id='task-1'").fetchone(),
    "output": db.execute("SELECT provider,phase,body,source FROM ai_outputs WHERE id='o1'").fetchone(),
    "decision": db.execute("SELECT decision,note FROM human_decisions WHERE id='d1'").fetchone(),
}
apply(files[6:])
assert db.execute("PRAGMA foreign_key_check").fetchall() == []
assert db.execute("SELECT template_key FROM tasks WHERE id='task-1'").fetchone()[0] == "general"
assert db.execute("SELECT template_key FROM tasks WHERE id='task-2'").fetchone()[0] == "general"
assert db.execute("SELECT title,instruction,document_text,status,mode FROM tasks WHERE id='task-1'").fetchone() == legacy["task"]
assert db.execute("SELECT provider,phase,body,source FROM ai_outputs WHERE id='o1'").fetchone() == legacy["output"]
assert db.execute("SELECT decision,note FROM human_decisions WHERE id='d1'").fetchone() == legacy["decision"]
rejects("UPDATE tasks SET instruction='oops' WHERE id='task-1'", contains="ORIGINAL_SOURCE_IMMUTABLE")
rejects("UPDATE tasks SET template_key='wrong' WHERE id='task-1'")
print("PASS: 0001-0010 migration, legacy content and task template defaults")

# Approved versions are append-only, with within-task lineage.
final_sql = """INSERT INTO final_versions
(id,task_id,version_no,parent_version_id,review_round_id,body,decision,note,source_snapshot_json,approved_at)
VALUES(?,?,?,?,?,?,?,?,?,?)"""
insert(final_sql, ("f1","task-1",1,None,"r1","核定第一版","partial","",json.dumps([{"status":"pending"}]),"t1"))
insert(final_sql, ("f2","task-1",2,"f1","r1","核定第二版","manual_revision","",json.dumps([{"status":"verified"}]),"t2"))
assert db.execute("SELECT version_no FROM final_versions WHERE task_id='task-1' ORDER BY version_no").fetchall() == [(1,), (2,)]
rejects("UPDATE final_versions SET body='不同' WHERE id='f1'", contains="FINAL_VERSION_IMMUTABLE")
rejects("DELETE FROM final_versions WHERE id='f1'", contains="FINAL_VERSION_IMMUTABLE")
rejects("DELETE FROM tasks WHERE id='task-1'", contains="TASK_WITH_FINAL_IMMUTABLE")
rejects(final_sql, ("bad1","task-2",2,"f1","r2","錯誤","partial","","[]","t3"),
        contains="FINAL_VERSION_CROSS_TASK_OR_LINEAGE")
rejects(final_sql, ("bad2","task-2",1,None,"r1","錯誤","partial","","[]","t3"),
        contains="FINAL_VERSION_CROSS_TASK_OR_LINEAGE")
rejects(final_sql, ("bad3","task-2",1,None,"r2","錯誤","partial","","{}", "t3"))
assert json.loads(db.execute("SELECT source_snapshot_json FROM final_versions WHERE id='f1'").fetchone()[0])[0]["status"] == "pending"
print("PASS: immutable v1/v2 finals, task-scoped version chain and snapshots")

# CAS: only the first writer based on revision 0 may succeed.
insert("INSERT INTO human_drafts(task_id,base_final_id,body,revision,updated_at) VALUES(?,?,?,?,?)",
       ("task-1","f2","手機初稿",0,"t0"))
stmt = "UPDATE human_drafts SET body=?,revision=revision+1,updated_at=? WHERE task_id=? AND revision=?"
assert insert(stmt, ("手機更新","t1","task-1",0)).rowcount == 1
assert insert(stmt, ("舊電腦覆寫","t2","task-1",0)).rowcount == 0
assert db.execute("SELECT body,revision FROM human_drafts WHERE task_id='task-1'").fetchone() == ("手機更新",1)
rejects("INSERT INTO human_drafts(task_id,base_final_id,body,revision,updated_at) VALUES(?,?,?,?,?)",
        ("task-2","f2","跨任務草稿",0,"t0"), contains="DRAFT_BASE_CROSS_TASK")
print("PASS: atomic draft compare-and-swap and cross-task parent guard")

# Provider output provenance and uneditable human curation lineage.
insert("INSERT INTO critique_parse_status(ai_output_id,status,checked_at) VALUES(?,?,?)",("o2","needs_human","t1"))
rejects("INSERT INTO critique_parse_status(ai_output_id,status,checked_at) VALUES(?,?,?)",
        ("o1","needs_human","t1"), contains="NOT_CRITIQUE_OUTPUT")
insert("""INSERT INTO review_objections(id,round_id,source_critique_output_id,target_output_id,
origin,anchor_kind,quoted_text,start_offset,end_offset,objection_text,created_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
       ("obj1","r1","o2","o1","ai","whole","",None,None,"需補資料","t1"))
rejects("""INSERT INTO review_objections(id,round_id,source_critique_output_id,target_output_id,
origin,anchor_kind,quoted_text,start_offset,end_offset,objection_text,created_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
        ("bad","r1","o2","o3","ai","whole","",None,None,"跨回合","t1"),
        contains="OBJECTION_CROSS_ROUND")
rejects("UPDATE ai_outputs SET body='被覆寫' WHERE id='o1'", contains="AI_OUTPUT_IMMUTABLE")
rejects("DELETE FROM ai_outputs WHERE id='o1'", contains="AI_OUTPUT_IMMUTABLE")
rejects("UPDATE review_objections SET objection_text='被改' WHERE id='obj1'",
        contains="OBJECTION_ORIGINAL_IMMUTABLE")
insert("""INSERT INTO objection_events(id,objection_id,action,actor,prior_revision,next_revision,details_json,created_at)
VALUES(?,?,?,?,?,?,?,?)""", ("evt1","obj1","correct","human",0,1,'{"note":"校正"}',"t2"))
rejects("UPDATE objection_events SET actor='system' WHERE id='evt1'",
        contains="OBJECTION_EVENT_IMMUTABLE")
print("PASS: anchored objections, original AI output immutability and human audit events")

# External source verification does not overwrite final's historical snapshot.
insert("""INSERT INTO source_checks
(id,task_id,related_ai_output_id,claim_text,source_label,status,updated_at)
VALUES(?,?,?,?,?,?,?)""", ("s1","task-1","o1","主張","資料","pending","t1"))
rejects("""INSERT INTO source_checks
(id,task_id,related_ai_output_id,claim_text,source_label,status,updated_at)
VALUES(?,?,?,?,?,?,?)""", ("badsource","task-2","o1","跨任務","資料","pending","t1"),
        contains="SOURCE_REFERENCE_CROSS_TASK")
rejects("""UPDATE source_checks SET status='verified' WHERE id='s1'""")
insert("UPDATE source_checks SET status=?,verified_by=?,verified_at=?,revision=revision+1 WHERE id=?",
       ("verified","human","t3","s1"))
assert db.execute("SELECT status FROM source_checks WHERE id='s1'").fetchone()[0] == "verified"
assert json.loads(db.execute("SELECT source_snapshot_json FROM final_versions WHERE id='f1'").fetchone()[0])[0]["status"] == "pending"
print("PASS: verified status requires a human; final snapshots remain historical")

# The new job and attempt tables are inert, bounded to a round and distinct from legacy counters.
insert("""INSERT INTO review_jobs(id,task_id,round_id,phase,state,updated_at)
VALUES(?,?,?,?,?,?)""",("job1","task-1","r1","independent","queued","t1"))
rejects("""INSERT INTO review_jobs(id,task_id,round_id,phase,state,updated_at)
VALUES(?,?,?,?,?,?)""",("badjob","task-2","r1","independent","queued","t1"),
        contains="JOB_CROSS_TASK")
attempt = """INSERT INTO review_model_attempts
(id,job_id,round_id,provider,phase,attempt_no,state,ai_output_id,started_at,updated_at)
VALUES(?,?,?,?,?,?,?,?,?,?)"""
insert(attempt,("at1","job1","r1","chatgpt","independent",1,"persisted","o1","t1","t1"))
rejects(attempt,("at2","job1","r1","gemini","independent",1,"persisted","o1","t1","t1"),
        contains="MODEL_ATTEMPT_LINK_MISMATCH")
rejects(attempt,("at3","job1","r1","gemini","independent",1,"persisted",None,"t1","t1"))
rejects("UPDATE review_model_attempts SET state='outcome_unknown' WHERE id='at1'",
        contains="MODEL_OUTPUT_ALREADY_PERSISTED")
insert("""INSERT INTO review_model_attempts
(id,job_id,round_id,provider,phase,attempt_no,state,started_at,updated_at)
VALUES(?,?,?,?,?,?,?,?,?)""",("at4","job1","r1","gemini","independent",1,"outcome_unknown","t1","t1"))
insert("""INSERT INTO retry_authorizations
(id,job_id,provider,phase,risk_ack,reason,idempotency_key,granted_at)
VALUES(?,?,?,?,?,?,?,?)""",("retry1","job1","gemini","independent",1,"已閱讀風險","unique-1","t2"))
rejects("""INSERT INTO retry_authorizations
(id,job_id,provider,phase,risk_ack,reason,idempotency_key,granted_at)
VALUES(?,?,?,?,?,?,?,?)""",("retry2","job1","gemini","independent",1,"已閱讀風險","unique-1","t2"))
insert("""INSERT INTO queue_outbox(id,job_id,action,state,created_at,updated_at)
VALUES(?,?,?,?,?,?)""",("out1","job1","start","pending","t1","t1"))
assert db.execute("PRAGMA foreign_key_check").fetchall() == []
print("PASS: job scoping, persisted-output integrity, unknown outcomes and unique retry tickets")
print("PASS: Phase 1 migration validation completed without Cloudflare, API keys or network calls")
