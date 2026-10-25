'use strict';
// Reads the desk's saved tasks from IndexedDB for assertions. Never creates the database:
// if it does not exist yet the upgrade is aborted and an empty state is returned.
exports.readState=page=>page.evaluate(()=>new Promise((resolve,reject)=>{
 const req=indexedDB.open('multi-ai-review-desk');
 req.onupgradeneeded=()=>req.transaction.abort();
 req.onerror=()=>resolve({tasks:[]});
 req.onsuccess=()=>{const db=req.result;const get=db.transaction('tasks').objectStore('tasks').getAll();
  get.onsuccess=()=>{db.close();resolve({tasks:get.result});};get.onerror=()=>reject(get.error);};
}));
