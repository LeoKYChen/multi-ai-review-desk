"""Verify offline v0.8 -> D1 import plan using disposable SQLite only."""
from pathlib import Path
import json
import sqlite3
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parents[2]
DB_SQL=ROOT/'cloudflare'/'migrations'
CLI=ROOT/'tools'/'convert-offline-backup.mjs'
DEMO=ROOT/'tools'/'fixtures'/'demo-v08-backup.json'
ORDER=('tasks','task_rounds','ai_outputs','human_decisions')
with tempfile.TemporaryDirectory(prefix='multi-ai-import-test-') as folder:
    target=Path(folder)/'plan.json'
    first=subprocess.run(['node',str(CLI),str(DEMO),'--output',str(target)],
                         capture_output=True,text=True,check=True)
    assert '任務 2；回合 2；模型回覆 8；人工決定 1' in first.stdout
    plan=json.loads(target.read_text(encoding='utf-8'))
    assert plan['format']=='multi-ai-d1-import-plan-v1'
    assert plan['source_format']=='multi-ai-offline-v0.8'
    assert plan['import_policy']=='create-only-no-overwrite'
    assert len(plan['source_sha256'])==64
    db=sqlite3.connect(':memory:')
    db.execute('PRAGMA foreign_keys=ON')
    for migration in sorted(DB_SQL.glob('*.sql')):
        db.executescript(migration.read_text(encoding='utf-8'))
    def import_atomic():
        db.execute('BEGIN')
        try:
            for table in ORDER:
                for row in plan['records'][table]:
                    keys=list(row)
                    sql=f"INSERT INTO {table} ({','.join(keys)}) VALUES ({','.join('?' for _ in keys)})"
                    db.execute(sql,[row[k] for k in keys])
            db.commit()
        except Exception:
            db.rollback()
            raise
    import_atomic()
    for table,expected in zip(ORDER,(2,2,8,1)):
        assert db.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]==expected,(table,expected)
    original=db.execute("SELECT title,document_text,category FROM tasks WHERE title LIKE 'O%'").fetchone()
    assert original==("O'Brien 文件審查","第1段：原文。\n第2段：含 '引用'。","文件審查")
    assert db.execute("SELECT DISTINCT source FROM ai_outputs").fetchone()[0]=='manual_unverified'
    assert db.execute("SELECT note FROM human_decisions").fetchone()[0]=="請補強第二段 '必要性'。"
    try:
        import_atomic()
        raise AssertionError('repeated import must fail without overwriting')
    except sqlite3.IntegrityError:
        pass
    assert db.execute('SELECT COUNT(*) FROM tasks').fetchone()[0]==2
    assert db.execute('SELECT COUNT(*) FROM ai_outputs').fetchone()[0]==8
    again=subprocess.run(['node',str(CLI),str(DEMO),'--output',str(target)],
                        capture_output=True,text=True)
    assert again.returncode!=0,'CLI must refuse overwriting an existing file'
print('PASS: offline v0.8 backup -> local D1 schema 0001-0005; record counts, text, integrity, duplicate rollback')
