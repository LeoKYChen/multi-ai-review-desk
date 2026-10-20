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
