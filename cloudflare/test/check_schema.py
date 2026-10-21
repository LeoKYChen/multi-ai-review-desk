from pathlib import Path
import sqlite3

migrations=Path(__file__).resolve().parents[1]/'migrations'
conn=sqlite3.connect(':memory:')
for sql in sorted(migrations.glob('*.sql')):
    conn.executescript(sql.read_text(encoding='utf-8'))
conn.execute("INSERT INTO tasks (id,title,instruction,document_text,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",('test-id','標題','交辦指令','Word文字','new','2026-10-20','2026-10-20'))
try:
    conn.execute("UPDATE tasks SET document_text='被覆寫' WHERE id='test-id'")
    raise AssertionError('Source must not be editable')
except sqlite3.IntegrityError as e:
    assert 'ORIGINAL_SOURCE_IMMUTABLE' in str(e)
assert conn.execute("SELECT document_text FROM tasks WHERE id='test-id'").fetchone()[0]=='Word文字'
updated=conn.execute('UPDATE tasks SET run_lock_until=100 WHERE id=? AND run_lock_until < 1',('test-id',))
assert updated.rowcount==1
assert conn.execute('UPDATE tasks SET run_lock_until=200 WHERE id=? AND run_lock_until < 1',('test-id',)).rowcount==0
print('PASS: D1 schema, immutable original text and model invocation lock')

# Login lock schema and API attempt quota are compatible with SQLite / D1.
assert 'login_rate_limits' in [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
assert 'model_call_attempts' in [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
conn.execute("INSERT INTO task_rounds(id,task_id,ordinal,state,created_at) VALUES (?,?,?,?,?)",('round-id','test-id',1,'running','2026-10-20'))
for i in range(3):
    row=conn.execute("""INSERT INTO model_call_attempts (id,task_id,round_id,provider,phase,requested_at)
      SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM model_call_attempts WHERE task_id=?) < ?
      AND (SELECT COUNT(*) FROM model_call_attempts WHERE requested_at>=?) < ?""",
      (f"attempt-{i}",'test-id','round-id','gemini','independent','2026-10-20T11:00:00.000Z','test-id',2,'2026-10-20T00:00:00.000Z',2))
    assert row.rowcount == (1 if i<2 else 0), f"cap failed at request {i}"
print('PASS: login rate tables and atomic call-count caps')

# v0.8 category migration preserves existing D1 tasks and original Word text.
columns=[row[1] for row in conn.execute('PRAGMA table_info(tasks)')]
assert 'category' in columns
assert conn.execute("SELECT category FROM tasks WHERE id='test-id'").fetchone()[0]=='一般'
conn.execute("UPDATE tasks SET category='文件審查' WHERE id='test-id'")
assert conn.execute("SELECT document_text FROM tasks WHERE id='test-id'").fetchone()[0]=='Word文字'
print('PASS: v0.8 category migration and source preservation')

# Queue migration is state-only: no model calls and no mutation to original task text.
assert 'queue_requested' in [row[1] for row in conn.execute('PRAGMA table_info(tasks)')]
assert conn.execute("SELECT queue_requested FROM tasks WHERE id='test-id'").fetchone()[0] == 0
assert conn.execute("SELECT document_text FROM tasks WHERE id='test-id'").fetchone()[0] == 'Word文字'
print('PASS: background queue migration 0006 is inert and preserves original text')
