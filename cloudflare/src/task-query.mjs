/** Parameterized D1 task browsing: never interpolate user search text into SQL. */
const STATUSES=new Set(['all','new','running','awaiting_human','needs_rework','closed','failed']);
function fail(message){throw Object.assign(new Error(message),{status:422});}
export function parseTaskFilters(url){
 const q=(url.searchParams.get('q')||'').trim();
 const status=url.searchParams.get('status')||'all';
 const category=url.searchParams.get('category')||'all';
 if(q.length>100)fail('搜尋內容不得超過 100 字元');
 if(!STATUSES.has(status))fail('任務狀態篩選無效');
 if(category!=='all'&&(!category.trim()||category.length>30))fail('分類篩選無效');
 return {q,status,category};
}
export function buildTaskListQuery({q='',status='all',category='all'}={}){
 const where=[],params=[];
 if(q){
  where.push('(INSTR(LOWER(title),LOWER(?))>0 OR INSTR(LOWER(instruction),LOWER(?))>0 OR INSTR(LOWER(category),LOWER(?))>0)');
  params.push(q,q,q);
 }
 if(status!=='all'){where.push('status=?');params.push(status);}
 if(category!=='all'){where.push('category=?');params.push(category);}
 const sql='SELECT id,title,status,mode,category,document_name,created_at,updated_at FROM tasks'+
  (where.length?' WHERE '+where.join(' AND '):'')+
  ' ORDER BY updated_at DESC LIMIT 100';
 return {sql,params};
}
