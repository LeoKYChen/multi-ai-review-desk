/** IndexedDB holds only UNSYNCED user draft text, never provider tokens.
 * Storage on this device is not encrypted by the application. */
const DB_NAME='feedback-desk-drafts-v1',STORE='unsynced',VERSION=1;
export function shouldClearCachedDraft(record,ack){
 return !!record&&!!ack&&record.local_edit_id===ack.local_edit_id&&
  record.task_id===ack.task_id&&record.base_revision===ack.base_revision&&
  record.body===ack.body;
}
export function detectDraftConflict(record,server){
 return !!record&&!!server&&record.base_revision!==server.revision;
}
export function draftPayload(taskId,body,serverRevision){
 return {task_id:taskId,body,base_revision:serverRevision,
  local_edit_id:crypto.randomUUID(),saved_at:new Date().toISOString()};
}
function open(){
 return new Promise((resolve,reject)=>{
  if(typeof indexedDB==='undefined')return reject(Error('此瀏覽器不支援離線草稿暫存'));
  const req=indexedDB.open(DB_NAME,VERSION);
  req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains(STORE))
   req.result.createObjectStore(STORE,{keyPath:'task_id'});};
  req.onsuccess=()=>resolve(req.result);
  req.onerror=()=>reject(req.error||Error('無法開啟本機草稿暫存'));
  req.onblocked=()=>reject(Error('本機草稿被其他分頁鎖定'));
 });
}
export async function readCachedDraft(taskId){
 const db=await open();
 try{return await new Promise((resolve,reject)=>{
  const req=db.transaction(STORE,'readonly').objectStore(STORE).get(taskId);
  req.onsuccess=()=>resolve(req.result||null);
  req.onerror=()=>reject(req.error);
 });}finally{db.close();}
}
export async function writeCachedDraft(record){
 const db=await open();
 try{return await new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,'readwrite');
  tx.objectStore(STORE).put(record);
  tx.oncomplete=()=>resolve(record);
  tx.onerror=()=>reject(tx.error);
  tx.onabort=()=>reject(tx.error);
 });}finally{db.close();}
}
export async function clearCachedDraftIf(ack){
 const db=await open();
 try{return await new Promise((resolve,reject)=>{
  let removed=false;
  const tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE);
  const req=store.get(ack.task_id);
  req.onsuccess=()=>{
   if(shouldClearCachedDraft(req.result,ack)){store.delete(ack.task_id);removed=true;}
  };
  tx.oncomplete=()=>resolve(removed);
  tx.onerror=()=>reject(tx.error);
  tx.onabort=()=>reject(tx.error);
 });}finally{db.close();}
}
export async function clearCachedDraft(taskId){
 const db=await open();
 try{return await new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,'readwrite');
  tx.objectStore(STORE).delete(taskId);
  tx.oncomplete=()=>resolve(true);
  tx.onerror=()=>reject(tx.error);
  tx.onabort=()=>reject(tx.error);
 });}finally{db.close();}
}
