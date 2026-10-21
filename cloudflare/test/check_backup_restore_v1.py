"""Phase 6: disposable SQLite backup/restore dry-run. No Cloudflare or API credentials."""
from pathlib import Path
import hashlib
import json
import sqlite3
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = sorted((ROOT / "migrations").glob("*.sql"))
EXPECTED = [f"{n:04d}" for n in range(1, 11)]
assert [p.name[:4] for p in MIGRATIONS] == EXPECTED

with tempfile.TemporaryDirectory(prefix="feedback-desk-rc-") as temp:
    source_path = Path(temp) / "before.db"
    restore_path = Path(temp) / "restored.db"
    before = sqlite3.connect(source_path)
    before.execute("PRAGMA foreign_keys=ON")
    for p in MIGRATIONS:
        before.executescript(p.read_text("utf8"))

    t, r = "task-rc", "round-rc"
    before.execute(
        "INSERT INTO tasks(id,title,instruction,document_text,status,created_at,updated_at,mode) VALUES(?,?,?,?,?,?,?,?)",
        (t, "合成測試任務", "請審查論點", "不可覆寫的合成文件", "closed", "t0", "t0", "api"),
    )
    before.execute(
        "INSERT INTO task_rounds(id,task_id,ordinal,state,created_at) VALUES(?,?,1,'closed',?)",
        (r, t, "t0"),
    )
    original = "合成法律論點需要查證"
    before.execute(
        "INSERT INTO ai_outputs(id,round_id,provider,phase,body,created_at) VALUES(?,?,?,?,?,?)",
        ("output-rc", r, "chatgpt", "independent", original, "t0"),
    )
    before.execute(
        "INSERT INTO ai_outputs(id,round_id,provider,phase,body,created_at) VALUES(?,?,?,?,?,?)",
        ("critique-rc", r, "gemini", "critique", "需要補強證據", "t1"),
    )
    before.execute(
        "INSERT INTO critique_parse_status(ai_output_id,status,checked_at) VALUES(?,?,?)",
        ("critique-rc", "resolved", "t1"),
    )
    before.execute(
        """INSERT INTO review_objections
        (id,round_id,source_critique_output_id,target_output_id,origin,anchor_kind,
         quoted_text,start_offset,end_offset,objection_text,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
        ("obj-rc", r, "critique-rc", "output-rc", "ai", "sentence",
         original, 0, len(original), "需要補正", "t1"),
    )
    before.execute(
        """INSERT INTO objection_events
        (id,objection_id,action,actor,prior_revision,next_revision,details_json,created_at)
        VALUES(?,?,?,'human',0,1,?,?)""",
        ("event-rc", "obj-rc", "correct",
         json.dumps({"patch": {"objection_text": "人工訂正"}}, ensure_ascii=False), "t2"),
    )
    before.execute(
        """INSERT INTO source_checks(id,task_id,related_ai_output_id,claim_text,source_label,status,
           verified_by,verified_at,revision,updated_at)
        VALUES(?,?,?,?,?,'verified','human',?,1,?)""",
        ("source-rc", t, "output-rc", "合成引用", "測試用來源", "t3", "t3"),
    )
    snapshot = json.dumps([{"id": "source-rc", "claim_text": "合成引用",
                            "status": "pending", "source_label": "測試用來源"}], ensure_ascii=False)
    before.execute(
        """INSERT INTO final_versions
        (id,task_id,version_no,parent_version_id,review_round_id,body,decision,note,source_snapshot_json,approved_at)
        VALUES(?,?,1,NULL,?,?,?,?,?,?)""",
        ("final-rc", t, r, "人類核定完整文字", "partial", "不自動決策", snapshot, "t2"),
    )
    before.execute(
        "INSERT INTO human_drafts(task_id,base_final_id,body,revision,updated_at) VALUES(?,?,?,?,?)",
        (t, "final-rc", "再修訂中", 2, "t3"),
    )
    before.execute(
        "INSERT INTO human_decisions(id,round_id,decision,note,created_at) VALUES(?,?,?,?,?)",
        ("decision-rc", r, "partial", "保留說明", "t2"),
    )
    before.execute(
        "INSERT INTO review_jobs(id,task_id,round_id,phase,state,updated_at) VALUES(?, ?, ?, 'proposal', 'completed', ?)",
        ("job-rc", t, r, "t3"),
    )
    before.execute(
        """INSERT INTO review_model_attempts
        (id,job_id,round_id,provider,phase,attempt_no,state,ai_output_id,started_at,updated_at)
        VALUES(?,?,?,'chatgpt','independent',1,'persisted',?,?,?)""",
        ("attempt-rc", "job-rc", r, "output-rc", "t1", "t1"),
    )
    before.execute(
        "INSERT INTO queue_outbox(id,job_id,action,state,created_at,updated_at) VALUES(?,?,'start','processed',?,?)",
        ("outbox-rc", "job-rc", "t1", "t3"),
    )
    before.commit()
    assert before.execute("PRAGMA foreign_key_check").fetchall() == []

    tables = ["tasks", "task_rounds", "ai_outputs", "review_objections",
              "objection_events", "source_checks", "final_versions", "human_drafts",
              "human_decisions", "review_jobs", "review_model_attempts", "queue_outbox"]
    def fingerprint(db):
        rows = []
        for table in tables:
            content = db.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()
            rows.append([table, content])
        blob = json.dumps(rows, ensure_ascii=False, default=str)
        return hashlib.sha256(blob.encode("utf8")).hexdigest()

    original_hash = fingerprint(before)
    with sqlite3.connect(restore_path) as after:
        before.backup(after)
        after.execute("PRAGMA foreign_keys=ON")
        assert fingerprint(after) == original_hash, "Backup data hash differs after restore"
        assert after.execute("PRAGMA foreign_key_check").fetchall() == []
        assert after.execute("SELECT body FROM ai_outputs WHERE id='output-rc'").fetchone()[0] == original
        assert json.loads(after.execute("SELECT source_snapshot_json FROM final_versions").fetchone()[0])[0]["status"] == "pending"
        assert after.execute("SELECT status FROM source_checks").fetchone()[0] == "verified"
        try:
            after.execute("UPDATE final_versions SET body='overwritten' WHERE id='final-rc'")
            raise AssertionError("Immutable formal final was edited")
        except sqlite3.IntegrityError as e:
            assert "FINAL_VERSION_IMMUTABLE" in str(e)
        try:
            after.execute("DELETE FROM tasks WHERE id=?", (t,))
            raise AssertionError("Deleting an approved task must fail")
        except sqlite3.IntegrityError:
            pass
        print("PASS: disposable SQLite/D1 backup restore hashes match")
        print("PASS: historical verification snapshot retained; current verification independent")
        print("PASS: AI original, structured objections, immutable finals and retry data restored")
        print("PASS: all foreign keys valid, immutable triggers active after restore")
    before.close()
print("PASS: Phase 6 local backup/restore completed without secrets or remote services")
