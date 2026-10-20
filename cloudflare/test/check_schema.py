from pathlib import Path
import sqlite3

sql=Path(__file__).resolve().parents[1]/'migrations'/'0001_init.sql'
conn=sqlite3.connect(':memory:')
conn.executescript(sql.read_text(encoding='utf-8'))
conn.execute("INSERT INTO tasks (id,title,instruction,document_text,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",('test-id','標題','交辦指令','Word文字','new','2026-10-20','2026-10-20'))
try:
    conn.execute("UPDATE tasks SET document_text='被覆寫' WHERE id='test-id'")
    raise AssertionError('Source must not be editable')
except sqlite3.IntegrityError as e:
    assert 'ORIGINAL_SOURCE_IMMUTABLE' in str(e)
assert conn.execute("SELECT document_text FROM tasks WHERE id='test-id'").fetchone()[0]=='Word文字'
print('PASS: D1 schema and source immutability')
