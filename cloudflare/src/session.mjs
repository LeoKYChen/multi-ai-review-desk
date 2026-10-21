/** Human browser session: signed HttpOnly cookie; never expose OWNER_TOKEN to client JS. */
const COOKIE='ma_session';
const TIMEOUT_SECONDS=12*60*60;
const encoder=new TextEncoder();
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const toHex=bytes=>Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');
async function sig(secret,text){
 const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return toHex(new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(text))));
}
function constantEqual(a,b){
 if(a.length!==b.length)return false;
 let diff=0;for(let i=0;i<a.length;i++) diff|=a.charCodeAt(i)^b.charCodeAt(i);
 return diff===0;
}
function tokenValid(env){return typeof env.OWNER_TOKEN==='string'&&env.OWNER_TOKEN.length>=32;}
function cookie(req){return (req.headers.get('Cookie')||'').split(';').map(p=>p.trim()).find(p=>p.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);}
export async function hasHumanAuth(req,env){
 if(!tokenValid(env)) fail(503,'尚未設定 OWNER_TOKEN');
 const auth=req.headers.get('Authorization');
 if(auth) return constantEqual(auth,`Bearer ${env.OWNER_TOKEN}`);
 const value=cookie(req);if(!value)return false;
 const [expiration,mac,extra]=value.split('.');if(extra||!/^[0-9]+$/.test(expiration||'')||!/^[a-f0-9]{64}$/.test(mac||''))return false;
 const now=Math.floor(Date.now()/1000),exp=Number(expiration);
 if(exp<=now||exp>now+TIMEOUT_SECONDS)return false;
 return constantEqual(mac,await sig(env.OWNER_TOKEN,`owner:${expiration}`));
}
export async function login(req,env){
 if(!tokenValid(env)||typeof env.OWNER_PASSWORD!=='string'||env.OWNER_PASSWORD.length<16)fail(503,'尚未設定安全的 OWNER_PASSWORD / OWNER_TOKEN');
 if(!req.headers.get('Content-Type')?.startsWith('application/json'))fail(415,'請使用 JSON');
 const text=await req.text();if(text.length>1000)fail(413,'登入資料過大');
 let data;try{data=JSON.parse(text);}catch{fail(400,'登入資料格式錯誤');}
 if(!data||typeof data.password!=='string'||!constantEqual(data.password,env.OWNER_PASSWORD))fail(401,'密碼錯誤');
 const exp=Math.floor(Date.now()/1000)+TIMEOUT_SECONDS;
 const signed=await sig(env.OWNER_TOKEN,`owner:${exp}`);
 return {headers:{'Set-Cookie':`${COOKIE}=${exp}.${signed}; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=${TIMEOUT_SECONDS}`},data:{authenticated:true}};
}
export function logoutHeaders(){return {'Set-Cookie':`${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/api; Max-Age=0`};}
