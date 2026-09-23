const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.warn('WARNING: ADMIN_PASSWORD is not set. Admin login will be unavailable until you set it.');
}
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function defaultConfig(){return {enabled:true,provider:'gemini',endpoint:'https://generativelanguage.googleapis.com/v1beta',model:'gemini-3.8-flash',apiKey:''};}
function readConfig(){let c=defaultConfig(); try{c={...c,...JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8'))}}catch{} if(process.env.GEMINI_API_KEY) c.apiKey=process.env.GEMINI_API_KEY; return c}
function writeConfig(c){fs.writeFileSync(CONFIG_FILE,JSON.stringify(c,null,2));}
if(!fs.existsSync(CONFIG_FILE)) writeConfig(defaultConfig());
ensureAdminPassword();
const sessions = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
function createSession(){ const token=crypto.randomBytes(32).toString('hex'); sessions.set(token, Date.now()+SESSION_TTL_MS); return token; }
function validSession(token){ const exp=sessions.get(token); if(!exp) return false; if(Date.now()>exp){sessions.delete(token); return false;} return true; }
function destroySession(token){ if(token) sessions.delete(token); }
function hashPassword(password, salt=crypto.randomBytes(16).toString('hex')){ const hash=crypto.scryptSync(password,salt,64).toString('hex'); return {salt,hash}; }
function passwordMatches(password, stored){ if(!password||!stored?.salt||!stored?.hash)return false; const actual=crypto.scryptSync(password,stored.salt,64).toString('hex'); return crypto.timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(stored.hash,'hex')); }
function ensureAdminPassword(){ let c=readConfig(); if(!c.adminPasswordHash && ADMIN_PASSWORD){ c.adminPasswordHash=hashPassword(ADMIN_PASSWORD); writeConfig(c); } return c; }


function send(res,status,data,headers={}){const body=typeof data==='string'?data:JSON.stringify(data);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(body)}
function serveFile(res,filePath){fs.readFile(filePath,(err,data)=>{if(err){send(res,404,{error:'Not found'});return}const ext=path.extname(filePath);const type=ext==='.html'?'text/html; charset=utf-8':ext==='.js'?'text/javascript; charset=utf-8':'text/plain; charset=utf-8';res.writeHead(200,{'Content-Type':type});res.end(data)})}
async function body(req){let chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks).toString('utf8');return raw?JSON.parse(raw):{}}
function adminToken(req){const a=req.headers.authorization||'';return a.startsWith('Bearer ')?a.slice(7):'';}
function adminOk(req){return validSession(adminToken(req));}
function stripCodeFence(s){return String(s).replace(/^```json\s*/i,'').replace(/\s*```$/,'').trim()}
function contentText(data){
  const c=data?.choices?.[0]?.message?.content;
  if(typeof c==='string') return c;
  if(Array.isArray(c)) return c.map(x=>typeof x==='string'?x:(x?.text||x?.content||'')).join('');
  if(typeof data?.output_text==='string') return data.output_text;
  if(Array.isArray(data?.output)) return data.output.flatMap(x=>Array.isArray(x?.content)?x.content:[]).map(x=>x?.text||x?.content||'').join('');
  return '';
}

async function callProvider(messages){
  const c=readConfig();
  if(!c.enabled) throw new Error('Global AI generation is disabled in the admin panel.');
  if(!c.apiKey) throw new Error('Gemini is not configured. Open Admin and add the global Gemini API key.');
  const model=c.model||'gemini-3.8-flash';
  const endpoint=(c.endpoint||'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/,'');
  const contents=[];
  for(const m of messages){
    if(m.role==='system') continue;
    contents.push({role:m.role==='assistant'?'model':'user',parts:[{text:String(m.content||'')}]});
  }
  const systemInstruction=messages.find(m=>m.role==='system')?.content||'';
  const body={contents};
  if(systemInstruction) body.systemInstruction={parts:[{text:String(systemInstruction)}]};
  const r=await fetch(`${endpoint}/models/${encodeURIComponent(model)}:generateContent`,{
    method:'POST',
    headers:{'Content-Type':'application/json','x-goog-api-key':c.apiKey},
    body:JSON.stringify(body)
  });
  const txt=await r.text();
  if(!r.ok) throw new Error(txt||`Gemini returned HTTP ${r.status}`);
  let data; try{data=JSON.parse(txt)}catch{throw new Error('Gemini returned non-JSON data.')}
  const content=data?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('')||'';
  if(!content) throw new Error(data?.promptFeedback?.blockReason?`Gemini blocked the request: ${data.promptFeedback.blockReason}`:'Gemini returned no text.');
  return content;
}

function stripCodeFence(s){return String(s).replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim()}
function parseJsonObject(s){
  const clean=stripCodeFence(s);
  try{return JSON.parse(clean)}catch{}
  const a=clean.indexOf('{'),b=clean.lastIndexOf('}');
  if(a>=0&&b>a) return JSON.parse(clean.slice(a,b+1));
  throw new Error('AI response was not valid JSON.');
}
const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(req.method==='GET'&&u.pathname==='/'){serveFile(res,path.join(__dirname,'index.html'));return}
    if(req.method==='GET'&&u.pathname==='/api/config'){const c=readConfig();send(res,200,{configured:!!c.apiKey,enabled:!!c.enabled,provider:'gemini',model:c.model,config:!!c.apiKey&&!!c.enabled});return}
    if(req.method==='POST'&&u.pathname==='/api/admin/login'){const b=await body(req);const c=ensureAdminPassword();if(!c.adminPasswordHash){send(res,503,{error:'Admin login is not configured. Set ADMIN_PASSWORD before starting the server.'});return}if(!passwordMatches(String(b.password||''),c.adminPasswordHash)){send(res,401,{error:'Invalid admin password'});return}const token=createSession();send(res,200,{token,config:{provider:'gemini',model:c.model,endpoint:c.endpoint,enabled:c.enabled,hasKey:!!c.apiKey}});return}
    if(req.method==='POST'&&u.pathname==='/api/admin/logout'){const token=adminToken(req);destroySession(token);send(res,200,{ok:true});return}
    if(req.method==='POST'&&u.pathname==='/api/admin/config'){if(!adminOk(req)){send(res,401,{error:'Unauthorized'});return}const b=await body(req);const old=readConfig();const c={...old,provider:'gemini',model:b.model||old.model||'gemini-3.8-flash',endpoint:'https://generativelanguage.googleapis.com/v1beta',enabled:b.enabled!==false};if(b.apiKey)c.apiKey=b.apiKey;writeConfig(c);send(res,200,{provider:'gemini',model:c.model,endpoint:c.endpoint,enabled:c.enabled,hasKey:!!c.apiKey});return}
    if(req.method==='GET'&&u.pathname==='/api/admin/config'){if(!adminOk(req)){send(res,401,{error:'Unauthorized'});return}const c=readConfig();send(res,200,{provider:'gemini',model:c.model,endpoint:c.endpoint,enabled:c.enabled,hasKey:!!c.apiKey});return}
    if(req.method==='POST'&&u.pathname==='/api/generate'){
      const p=await body(req);
      const docs=(p.documents||[]).map(d=>`\nDOCUMENT ${d.name}:\n${String(d.text||'').slice(0,50000)}`).join('');
      const system=`You are an expert IB MYP assessment author. Generate genuinely NEW, specific questions from the student's requested topic. Never use placeholders such as "Question 1", "Question 2", "a question about...", or generic instructions. Each item must be a complete question that could be given to a student immediately. Base the content tightly on the requested SUBJECT, TOPIC, CRITERION and difficulty.

Return ONLY valid JSON in this exact shape: {"questions":[{"id":"1","type":"Long answer|MCQ|MCQ Multiple|True / False|Fill in the blanks|Question with sub-parts","text":"complete student-facing question","options":["option 1","option 2","option 3","option 4"],"answer":0,"marks":6,"criterion":"${p.criterion}","criterionName":"${p.criterionName}","explanation":"brief reasoning for the correct answer or marking focus"}]}.

Requirements: ${p.allowMCQ?'MCQs are permitted when the requested question type uses them; otherwise follow the requested type exactly.':'Do not use MCQs.'} For MCQ provide exactly 4 plausible options and one correct answer. For MCQ Multiple provide 4 or 5 plausible options and an array of correct option indices. For True / False provide two options or omit options and use answer 0/1. For long-answer or sub-part questions, do not include a student answer, but include an explanation describing the expected reasoning. Avoid repeating scenarios or wording. Make every question materially different. If source documents are provided, use their actual content and terminology; never invent facts that contradict them.`;
      const user=`SUBJECT: ${p.subject}\nIB CRITERION: ${p.criterion} — ${p.criterionName}\nCRITERION DESCRIPTION: ${p.criterionDescription||''}\nQUESTION TYPE: ${p.qtype}\nDIFFICULTY: ${p.difficulty}\nNUMBER OF QUESTIONS: ${p.count}\nTOPIC / REQUEST: ${p.prompt}\nADDITIONAL INSTRUCTIONS: ${p.extra||'None'}\nSOURCE DOCUMENTS:${docs||' None'}`;
      const content=await callProvider([{role:'system',content:system},{role:'user',content:user}]);
      const parsed=parseJsonObject(content);if(!Array.isArray(parsed.questions)||parsed.questions.length===0) throw new Error('AI returned no questions.');
      send(res,200,{questions:parsed.questions.slice(0,Math.max(1,Number(p.count)||5))});return;
    }
    if(req.method==='POST'&&u.pathname==='/api/review'){
      const p=await body(req);
      const system=`You are an objective IB MYP assessment reviewer. Review each student's response against the exact generated question and criterion. Return ONLY valid JSON: {"results":[{"score":0,"feedback":"specific feedback","result":"Correct|Partially correct|Needs improvement|Not answered","improvement":"specific next step"}]}. Award an integer or sensible decimal score from 0 to that question's marks. For MCQs use the stored answer key. For written responses, judge the actual content, reasoning, evidence, calculations and criterion alignment. Do not invent what the student wrote.`;
      const content=await callProvider([{role:'system',content:system},{role:'user',content:JSON.stringify({config:p.config,questions:p.questions,answers:p.answers,documents:p.documents})}]);
      const parsed=parseJsonObject(content);if(!Array.isArray(parsed.results)) throw new Error('AI reviewer returned no results.');send(res,200,{results:parsed.results});return;
    }
    if(req.method==='GET'){
      const requested=decodeURIComponent(u.pathname);
      if(requested.includes('..') || requested.startsWith('/data/') || requested.startsWith('/api/')){send(res,404,{error:'Not found'});return}
      const filePath=path.join(__dirname,requested==='/'?'/index.html':requested);
      if(!filePath.startsWith(__dirname)){send(res,404,{error:'Not found'});return}
      serveFile(res,filePath);return
    }
    send(res,404,{error:'Not found'});
  }catch(e){send(res,500,{error:e.message||String(e)})}
});
server.listen(PORT,HOST,()=>console.log(`Assessment Studio running at http://${HOST}:${PORT}`));
