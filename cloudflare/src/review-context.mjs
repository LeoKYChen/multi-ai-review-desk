/** Carry explicit human rework instructions into the NEXT round without changing source. */
export async function getPreviousReworkNote(env,taskId,ordinal){
 if(ordinal<=1)return '';
 const row=await env.DB.prepare(`SELECT h.note AS note FROM human_decisions h
  JOIN task_rounds r ON r.id=h.round_id
  WHERE r.task_id=? AND r.ordinal<? AND h.decision='rework'
  ORDER BY r.ordinal DESC LIMIT 1`).bind(taskId,ordinal).first();
 return typeof row?.note==='string'?row.note:'';
}
