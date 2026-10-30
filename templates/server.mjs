import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { renderCoursePackage } from './course-render.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _IS_KIT = fs.existsSync(path.join(__dirname,'course','course.html'));
const ROOT = _IS_KIT ? __dirname : path.resolve(__dirname, '..');
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PORT = Number(process.env.PORT || 8899);
const DS_KEY = process.env.DEEPSEEK_API_KEY || '';
const DS_BASE = process.env.DEEPSEEK_BASE || 'https://api.deepseek.com';
const DS_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
const GROUPS = ['A','B','C','D','E','F','G'];
const ROOMS_DIR = path.join(DATA_DIR,'rooms');
const DEFAULT_ROOM = 'ROOM0';
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PACKAGES_DIR = path.join(DATA_DIR,'packages');
const TEACHERS_FILE = path.join(DATA_DIR,'teachers.json');
const SESSION_SECRET = process.env.SESSION_SECRET || 'gtscdt-dev-secret';
const AUTH_REQUIRED = process.env.REQUIRE_AUTH === '1';
const LOCAL_PASSWORD = process.env.LOCAL_TEACHER_PASSWORD || '';
const DING_ID = process.env.DINGTALK_CLIENT_ID || '';
const DING_SECRET = process.env.DINGTALK_CLIENT_SECRET || '';
function sign(v){ return crypto.createHmac('sha256',SESSION_SECRET).update(v).digest('hex').slice(0,32); }
function setTeacherCookie(res, teacher){ const v=Buffer.from(JSON.stringify({id:teacher.id,name:teacher.name,role:teacher.role,exp:Date.now()+7*864e5})).toString('base64url'); res.setHeader('Set-Cookie','gtsc_teacher='+v+'.'+sign(v)+'; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800'); }
function getCookieTeacher(req){ const raw=String(req.headers.cookie||''); const m=raw.match(/(?:^|;\s*)gtsc_teacher=([^;]+)/); if(!m)return null; const [v,sig]=m[1].split('.'); if(!v||!sig||sign(v)!==sig)return null; try{ const t=JSON.parse(Buffer.from(v,'base64url').toString()); if(!t.exp||t.exp<Date.now())return null; return t; }catch(e){ return null; } }
function bearerToken(req){ const h=String(req.headers.authorization||'').trim(); if(h.toLowerCase().indexOf('bearer ')===0)return h.slice(7).trim(); return String(req.headers['x-mcp-token']||'').trim(); }
function getTeacher(req){ return getCookieTeacher(req) || teacherByMcpToken(bearerToken(req)); }
async function dingDept(unionId){
  const corp=process.env.DINGTALK_CORP_ID||'';
  if(!(corp&&DING_ID&&DING_SECRET&&unionId)) return '';
  try{
    const tr=await fetch('https://oapi.dingtalk.com/gettoken?appkey='+encodeURIComponent(DING_ID)+'&appsecret='+encodeURIComponent(DING_SECRET));
    const tj=await tr.json(); if(!tj.access_token) return '';
    const u1=await fetch('https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token='+tj.access_token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({unionid:unionId})});
    const j1=await u1.json(); const userid=j1.result&&j1.result.userid;
    if(!userid) return '';
    const u2=await fetch('https://oapi.dingtalk.com/topapi/v2/user/get?access_token='+tj.access_token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userid})});
    const j2=await u2.json(); const list=(j2.result&&j2.result.dept_id_list)||[];
    return list.length?list.join('/'):'';
  }catch(e){ return ''; }
}
function loadTeachers(){ try{ return JSON.parse(fs.readFileSync(TEACHERS_FILE,'utf8')); }catch(e){ return []; } }
function freshTeacher(t){ if(!t) return t; try{ const list=loadTeachers(); const m=list.filter(function(x){return x.id===t.id||(t.dingUnionId&&x.dingUnionId===t.dingUnionId);})[0]; return m?Object.assign({},t,m):t; }catch(e){ return t; } }
function saveTeachers(list){ fs.mkdirSync(path.dirname(TEACHERS_FILE),{recursive:true}); fs.writeFileSync(TEACHERS_FILE, JSON.stringify(list,null,1)); }

// 讲师级 MCP 令牌：每个讲师在个人页面看到自己的 token，可重置。
const MCP_TOKENS_FILE = path.join(DATA_DIR,'mcp-tokens.json');
function loadMcpTokens(){ try{ const j=JSON.parse(fs.readFileSync(MCP_TOKENS_FILE,'utf8')); return (j&&j.tokens)||{}; }catch(e){ return {}; } }
function saveMcpTokens(tokens){ fs.mkdirSync(path.dirname(MCP_TOKENS_FILE),{recursive:true}); fs.writeFileSync(MCP_TOKENS_FILE, JSON.stringify({tokens:tokens||{}},null,1)); }
function mcpTeacherId(t){ return String((t&&(t.id||t.dingUnionId||t.dingUserId))||''); }
function ensureMcpToken(t){
  if(!t) return null;
  const id=mcpTeacherId(t); if(!id) return null;
  const tokens=loadMcpTokens(); let rec=tokens[id];
  if(rec&&rec.token) { if(rec.name!==t.name){ rec.name=t.name||''; tokens[id]=rec; saveMcpTokens(tokens); } return rec; }
  rec={token:'ysc_'+crypto.randomBytes(24).toString('hex'),name:t.name||'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  tokens[id]=rec; saveMcpTokens(tokens); return rec;
}
function resetMcpToken(t){
  if(!t) return null;
  const id=mcpTeacherId(t); if(!id) return null;
  const tokens=loadMcpTokens();
  const rec={token:'ysc_'+crypto.randomBytes(24).toString('hex'),name:t.name||'',createdAt:(tokens[id]&&tokens[id].createdAt)||new Date().toISOString(),updatedAt:new Date().toISOString()};
  tokens[id]=rec; saveMcpTokens(tokens); return rec;
}
function teacherByMcpToken(token){
  const tok=String(token||'').trim(); if(!tok) return null;
  const tokens=loadMcpTokens();
  for(const id of Object.keys(tokens)){
    const rec=tokens[id]||{}; if(rec.token!==tok) continue;
    if(id==='local') return {id:'local',name:rec.name||'本地讲师',role:'admin'};
    const t=loadTeachers().filter(function(x){return String(x.id)===id||String(x.dingUnionId)===id||String(x.dingUserId)===id})[0];
    return t?Object.assign({},t,{id:id}):null;
  }
  return null;
}
function canMcpRoom(t, code){
  if(!t || t.role==='admin') return true;
  try{ const meta=JSON.parse(fs.readFileSync(roomMetaFile(code),'utf8')); return !!(meta&&meta.owner&&String(meta.owner)===String(t.id)); }catch(e){ return false; }
}

let currentRoom = DEFAULT_ROOM;
function roomStateFile(code){ return code===DEFAULT_ROOM ? STATE_FILE : path.join(ROOMS_DIR, code, 'state.json'); }
function roomMetaFile(code){ return code===DEFAULT_ROOM ? path.join(DATA_DIR, 'room.json') : path.join(ROOMS_DIR, code, 'room.json'); }
const ROOM_META_CACHE={};
function cachedRoomMeta(code){ const n=Date.now(), c=ROOM_META_CACHE[code]; if(c&&n-c.at<3000)return c.data; let data={}; try{ data=JSON.parse(fs.readFileSync(roomMetaFile(code),'utf8')); }catch(e){} ROOM_META_CACHE[code]={at:n,data:data}; return data; }
function clearRoomMetaCache(code){ delete ROOM_META_CACHE[code]; }
function validRoom(c){ return /^[A-Z0-9]{4}$/.test(String(c||'')); }
function loadRoom(code){
  const f=roomStateFile(code);
  if(!fs.existsSync(f)) return blank();
  try{ return Object.assign(blank(), JSON.parse(fs.readFileSync(f,'utf8'))); }catch(e){ return blank(); }
}
function saveRoom(code, st){ const f=roomStateFile(code); fs.mkdirSync(path.dirname(f),{recursive:true}); fs.writeFileSync(f, JSON.stringify(st)); }
function listRooms(teacher){
  const out=[];
  const one=function(code){
    let meta={}; try{ meta=JSON.parse(fs.readFileSync(roomMetaFile(code),'utf8')); }catch(e){}
    const st=loadRoom(code);
    const _t=teacher||{}; if(_t.role!=='admin'){ if(code===DEFAULT_ROOM||!meta.owner||meta.owner!==_t.id) return; }
    out.push({code,title:meta.title||('课堂 '+code),city:meta.city||'',date:meta.date||'',owner:meta.owner||'',province:meta.province||'',project:meta.project||'',files:(meta.files||[]).map(function(f){return Object.assign({},f,{url:'/api/room/file?name='+encodeURIComponent(f.stored)+'&room='+encodeURIComponent(code)})}),frameworkUrl:meta.frameworkUrl||'',createdAt:meta.createdAt||'',students:Object.keys(st.students||{}).length,active:!!(st.poll&&st.poll.active)||!!(st.quiz&&st.quiz.paper&&st.quiz.paper.active)});
  };
  one(DEFAULT_ROOM);
  if(fs.existsSync(ROOMS_DIR)) fs.readdirSync(ROOMS_DIR).forEach(function(d){ if(validRoom(d)&&d!==DEFAULT_ROOM) one(d); });
  return out;
}
function createRoom(title, city, date, owner, province, project){
  let code='';
  for(let i=0;i<50;i++){ code=Array.from({length:4},()=>ROOM_ALPHABET[Math.floor(Math.random()*ROOM_ALPHABET.length)]).join(''); if(!fs.existsSync(roomStateFile(code))) break; }
  const d=String(date||new Date().toISOString().slice(0,10));
  const rawProv=String(province||'').trim(); const rawCity=String(city||'').trim(); const pj=String(project||'').trim();
  const prov=rawProv||'浙江省'; const c=rawCity||(rawProv?'':'杭州市');
  const t=String(title||'').trim()||(d+' '+(pj||'未命名客户/项目'));
  fs.mkdirSync(path.join(ROOMS_DIR,code),{recursive:true});
  fs.writeFileSync(roomMetaFile(code), JSON.stringify({title:t,city:c,date:d,province:prov,project:pj,owner:owner||'',createdAt:new Date().toISOString()},null,1));
  saveRoom(code, blank());
  return code;
}
const roomCache={};
function setRoom(code){ currentRoom = validRoom(code) ? code : DEFAULT_ROOM; state = roomCache[currentRoom] || (roomCache[currentRoom] = loadRoom(currentRoom)); }
function cookieRoom(req){ const m=String(req.headers.cookie||'').match(/(?:^|;\s*)gtsc_room=([A-Z0-9]{4})/); return m?m[1]:''; }

function ensureDir(){ if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true}); }
function blank(){
  const groups={}; GROUPS.forEach(g=>groups[g]={name:g+'组',perf:0});
  return {students:{},groups,poll:{active:false,question:'',options:[],votes:{},startedAt:''},submissions:{},config:{hwOpen:false,workshopOpen:false,materialOpen:false,screenView:'stats',slide:0,groupMax:3,groupsEnabled:true,reviewEnabled:true,hwCount:6,wsMinutes:90,activeCard:'',model:{baseUrl:'https://api.deepseek.com',model:'deepseek-flash',apiKey:''}},buzz:{enabled:false,running:false,winner:'',round:0,at:''},tasks:[],votePresets:[],cards:[],materials:[],rubrics:{},roll:{active:false,key:'',name:'',round:0,at:0},timer:{running:false,endAt:0,duration:0},quiz:{bank:{choice:[],judge:[],blank:[],short:[]},config:{mode:'random',counts:{choice:5,judge:3,blank:2,short:1},scores:{choice:2,judge:2,blank:3,short:10}},paper:null,answers:{}},updatedAt:new Date().toISOString()};
}
function load(){ ensureDir(); if(!fs.existsSync(STATE_FILE)) return blank();
  try{ const s=JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); return Object.assign(blank(),s); }catch(e){ return blank(); } }
let state = loadRoom(DEFAULT_ROOM);
try{
  state.config=state.config||{};
  if(!state.config.model) state.config.model={baseUrl:'https://api.deepseek.com',model:'deepseek-flash',apiKey:''};
  if(!state.config.model.apiKey && process.env.DEEPSEEK_API_KEY){ state.config.model.baseUrl=process.env.DEEPSEEK_BASE||'https://api.deepseek.com'; state.config.model.model=process.env.DEEPSEEK_MODEL||'deepseek-flash'; state.config.model.apiKey=process.env.DEEPSEEK_API_KEY; }
}catch(e){}
let saveTimer=null;
function save(){ clearTimeout(saveTimer); const room=currentRoom; try{ saveRoom(room, state); }catch(e){ console.error('save fail',e.message); } }
function groupsOn(){ return !(state.config&&state.config.groupsEnabled===false); }
function reviewOn(){ return !(state.config&&state.config.reviewEnabled===false); }
function hwCountOn(){ return Math.max(1,Math.min(6,Number(state.config&&state.config.hwCount)||6)); }
function taskAllowed(t){ const m=/^T([1-6])$/.exec(String(t||'')); return !!m && Number(m[1])<=hwCountOn(); }
function keyOf(name,tail){ return String(name||'').trim()+'|'+String(tail||'').trim(); }
function groupCounts(){ const c={}; Object.keys(state.groups).forEach(g=>c[g]=0); Object.values(state.students).forEach(s=>{ if(s.group&&c[s.group]!==undefined) c[s.group]++ }); return c; }
function ensureStudent(name,tail){ const k=keyOf(name,tail); if(!state.students[k]){ state.students[k]={name:String(name).trim(),tail:String(tail).trim(),group:'',score:0,votes:0,buzzes:0,joinedAt:new Date().toISOString()}; save(); } return state.students[k]; }
function qTok(s){return String(s||'').replace(/[\s，。；、,.!?！？:：;；"'“”‘’（）()]/g,'').toLowerCase().split('');}
function qSim(a,b){var A=qTok(a),B=qTok(b);if(!A.length||!B.length)return 0;var m={};A.forEach(function(c){m[c]=(m[c]||0)+1});var hit=0;B.forEach(function(c){if(m[c]){hit++;m[c]--}});return hit/Math.max(A.length,B.length);}
function qGrade(q,ans){ if(q.type==='choice')return String(ans||'').toUpperCase()===String(q.answer||'').toUpperCase()?1:0; if(q.type==='judge'||q.type==='blank')return String(ans||'').trim()===String(q.answer||'').trim()?1:0; return Math.round(qSim(ans,q.ref)*100)/100; }
function modelCfg(){
  const c=(state.config&&state.config.model)||{};
  return {base:(c.baseUrl||process.env.DEEPSEEK_BASE||'https://api.deepseek.com').replace(/\/$/,''),model:c.model||process.env.DEEPSEEK_MODEL||'deepseek-flash',key:c.apiKey||process.env.DEEPSEEK_API_KEY||''};
}
async function modelChat(messages,maxTokens,json){
  const cfg=modelCfg(); if(!cfg.key) return {ok:false,error:'未配置 API Key'};
  const t0=Date.now();
  try{
    const payload={model:cfg.model,messages:messages,temperature:0,max_tokens:maxTokens||600};
    if(json) payload.response_format={type:'json_object'};
    const r=await fetch(cfg.base+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+cfg.key},body:JSON.stringify(payload)});
    const txt=await r.text();
    if(!r.ok) return {ok:false,error:'HTTP '+r.status+' '+txt.slice(0,160)};
    const j=JSON.parse(txt);
    const _msg=(((j.choices||[])[0]||{}).message||{});
    const content=_msg.content||_msg.reasoning_content||'';
    return {ok:true,content,ms:Date.now()-t0,model:cfg.model};
  }catch(e){ return {ok:false,error:String(e.message||e)}; }
}
async function qModelGrade(q,ans){
  const prompt='你是课堂评分助教。请判断学员答案与参考答案的匹配程度，只输出 0-100 的整数，不要解释。\n题目：'+q.q+'\n参考答案：'+q.ref+'\n学员答案：'+(ans||'（未作答）');
  const r=await modelChat([{role:'user',content:prompt}],600);
  if(!r.ok){ console.error('[qmodel] fail:',r.error); return null; }
  const n=parseInt(String(r.content).replace(/[^0-9]/g,''),10);
  if(isNaN(n)) return null;
  return Math.max(0,Math.min(100,n));
}
function quizBuildPaper(cfg){
  cfg=cfg||{}; const counts=cfg.counts||{}, scores=cfg.scores||{};
  const pick=function(t,n){
    let arr=(state.quiz.bank[t]||[]).slice();
    if(cfg.mode!=='seq'){ for(let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); const x=arr[i];arr[i]=arr[j];arr[j]=x; } }
    return arr.slice(0,Math.max(0,Math.min(Number(n)||0,arr.length))).map(function(q){ const c=Object.assign({},q); c.type=t; c.score=Number(scores[t]||0)||0; return c; });
  };
  return [].concat(pick('choice',counts.choice),pick('judge',counts.judge),pick('blank',counts.blank),pick('short',counts.short));
}
function quizPaperFor(k){
  const q=state.quiz||{}; const pz=q.paper;
  if(!pz||!pz.active) return [];
  if(pz.mode!=='random') return pz.questions||[];
  q.papers=q.papers||{};
  if(!q.papers[k]){ q.papers[k]=quizBuildPaper(q.config||pz); save(); }
  return q.papers[k];
}
function studentView(k){
  const s=state.students[k];
  const poll=state.poll;
  const voted=!!(poll.votes&&poll.votes[k]!==undefined);
  let groupPerf=0,groupScore=0;
  if(s&&s.group){
    groupPerf=state.groups[s.group]?state.groups[s.group].perf:0;
    const gsub=Object.keys(state.submissions).reduce((a,k2)=>{const st=state.students[k2.split('||')[0]];return a+((st&&st.group===s.group)?(((state.submissions[k2].score)||{}).total||0):0)},0);
    groupScore=groupPerf+gsub;
  }
  let _hwScore=0; Object.keys(state.submissions||{}).forEach(function(sk){ if(sk.indexOf(k+'||')===0)_hwScore+=(((state.submissions[sk]||{}).score||{}).total||0); });
  const _quizScore=((((state.quiz||{}).answers||{})[k])||{}).score||0;
  const _personalScore=Math.round((_hwScore+_quizScore)*10)/10;
  const _groupsOn=groupsOn();
  return {
    ok:true,
    room: currentRoom,
    me: s?{name:s.name,tail:s.tail,group:s.group,score:_groupsOn?groupScore:_personalScore,groupPerf:groupPerf,groupScore:groupScore,individualScore:_personalScore,hwScore:_hwScore,quizScore:_quizScore}:null,
    groupsEnabled:_groupsOn,reviewEnabled:reviewOn(),hwCount:hwCountOn(),
    poll: poll.active?{active:true,question:poll.question,options:poll.options,voted,myVote:voted?poll.votes[k]:null,startedAt:poll.startedAt}:{active:false},
    hwOpen: !!(state.config&&state.config.hwOpen),
    workshopOpen: !!(state.config&&state.config.workshopOpen),
    tasksVersion:(state.tasks&&state.tasks.length)?(function(){try{return fs.statSync(path.join(DATA_DIR,'rooms',currentRoom,'assets','quests.html')).mtimeMs}catch(e){return 0}})():0,
    tasksCount:(state.tasks||[]).length,
    roll:(function(){var r=state.roll||{};return {active:!!r.active,name:r.name||'',selected:!!(r.active&&r.key===k)};})(),
    card:(function(){ if(!(state.config&&state.config.workshopOpen)) return null; var c=(state.cards||[]).filter(function(x){return x.id===state.config.activeCard})[0]; return c?{theme:c.theme,type:c.type,content:c.content,attrs:c.attrs}:null; })(),
    materialOpen:!!(state.config&&state.config.materialOpen),
    materials:(function(){var out=[];try{var m=cachedRoomMeta(currentRoom);out=(m.files||[]).filter(function(f){return f.released!==false}).map(function(f){return {name:f.name,url:'/api/room/file?name='+encodeURIComponent(f.stored)+'&room='+encodeURIComponent(currentRoom)}})}catch(e){}; (state.materials||[]).forEach(function(x){out.push({name:x.name,url:x.url,type:x.type||''})}); return out})(),
    tasks:(state.tasks||[]).map(function(t){return {id:t.id,title:t.title,scenario:t.scenario,requirements:t.requirements||[],deliverable:t.deliverable||'',acceptance:t.acceptance||''}}),
    timer:{running:!!(state.timer&&state.timer.running),endAt:(state.timer&&state.timer.endAt)||0,left:(state.timer&&state.timer.running)?Math.max(0,state.timer.endAt-Date.now()):0},
    buzz:{enabled:!!(state.buzz&&state.buzz.enabled),running:!!(state.buzz&&state.buzz.running),winner:(state.buzz&&state.buzz.winner)||'',winnerKey:(state.buzz&&state.buzz.winnerKey)||'',won:!!(state.buzz&&state.buzz.winnerKey&&state.buzz.winnerKey===k),round:(state.buzz&&state.buzz.round)||0},
    quiz:(function(){var q=state.quiz||{};var p=q.paper;if(!p||!p.active)return {active:false};var a=(q.answers||{})[k];var qs=quizPaperFor(k);return {active:true,submitted:!!a,myScore:a?a.score:null,total:qs.reduce(function(x,y){return x+(y.score||0)},0),questions:qs.map(function(x){return {id:x.id,type:x.type,q:x.q,options:x.options||[],score:x.score}})};})(),
    groupCounts: groupCounts(),
    groups: Object.keys(state.groups).map(g=>({id:g,name:state.groups[g].name})),
    submissions: s? Object.keys(state.submissions).filter(k2=>k2.indexOf(k+'||')===0).map(k2=>{const p=k2.split('||');return {task:p[1],at:state.submissions[k2].at,total:(state.submissions[k2].score||{}).total||0,files:(state.submissions[k2].files||[]).length}}):[]
  };
}

function remoteView(){
  const cfg=state.config||{}, poll=state.poll||{}, buzz=state.buzz||{}, quiz=state.quiz||{};
  let roomTitle=''; try{ roomTitle=cachedRoomMeta(currentRoom).title||''; }catch(e){}
  const paper=quiz.paper||{}, timer=state.timer||{}, roll=state.roll||{};
  const groups=Object.keys(state.groups||{}).map(function(g){return {id:g,name:(state.groups[g]&&state.groups[g].name)||g,perf:Number((state.groups[g]&&state.groups[g].perf)||0)}});
  const cards=(state.cards||[]).map(function(c){return {id:c.id,theme:c.theme,type:c.type}});
  const active=(state.cards||[]).filter(function(c){return c.id===cfg.activeCard})[0]||null;
  return {
    ok:true,room:currentRoom,title:roomTitle,materialOpen:!!cfg.materialOpen,hwOpen:!!cfg.hwOpen,groupsEnabled:groupsOn(),reviewEnabled:reviewOn(),hwCount:hwCountOn(),screenView:cfg.screenView||'data',screenDataTab:cfg.screenDataTab||'base',
    screenView:cfg.screenView||'data',workshopOpen:!!cfg.workshopOpen,
    groups:groups,
    roll:{active:!!roll.active,name:roll.name||'',round:roll.round||0},
    poll:{active:!!poll.active,question:poll.question||'',options:poll.options||[],count:Object.keys(poll.votes||{}).length,results:poll.results||{},startedAt:poll.startedAt||''},
    buzz:{enabled:!!buzz.enabled,running:!!buzz.running,winner:buzz.winner||'',winnerKey:buzz.winnerKey||'',round:buzz.round||0},
    quiz:{active:!!paper.active,mode:paper.mode||(quiz.config&&quiz.config.mode)||'',count:paper.count||((paper.questions||[]).length),answered:Object.keys(quiz.answers||{}).length,bank:{choice:((quiz.bank||{}).choice||[]).length,judge:((quiz.bank||{}).judge||[]).length,blank:((quiz.bank||{}).blank||[]).length,short:((quiz.bank||{}).short||[]).length}},
    timer:{running:!!timer.running,endAt:timer.endAt||0,left:timer.running?Math.max(0,(timer.endAt||0)-Date.now()):0,workshopOpen:!!cfg.workshopOpen},
    activeCard:active?{id:active.id,theme:active.theme,type:active.type,content:active.content}:null,
    cards:cards,
    presets:(state.votePresets||[]).map(function(v){return {id:v.id,question:v.question,options:v.options}})
  };
}

function adminView(){
  const counts=groupCounts();
  const qz=state.quiz||{bank:{},config:{},paper:null,answers:{}};
  const qbank={choice:(qz.bank.choice||[]).length,judge:(qz.bank.judge||[]).length,blank:(qz.bank.blank||[]).length,short:(qz.bank.short||[]).length};
  const qans=Object.keys(qz.answers||{}).map(function(k){return qz.answers[k]});
  const quizInfo={bank:qbank,config:qz.config||{},paper:qz.paper?{active:!!qz.paper.active,at:qz.paper.at,count:qz.paper.questions.length,points:qz.paper.questions.reduce(function(a,b){return a+(b.score||0)},0)}:null,answered:qans.length,avg:qans.length?Math.round(qans.reduce(function(a,b){return a+(b.score||0)},0)/qans.length*10)/10:0};
  const results={};
  if(state.poll.options&&state.poll.options.length){ state.poll.options.forEach((o,i)=>{results[i]=0}); Object.values(state.poll.votes||{}).forEach(v=>{ if(results[v]!==undefined) results[v]++ }); }
  const subs=Object.keys(state.submissions).map(k=>{ const p=k.split('||'); const st=state.students[p[0]]||{}; const sub=state.submissions[k]; return {key:k,studentKey:p[0],name:st.name||p[0],tail:st.tail||'',task:p[1],text:sub.text||'',fileName:sub.fileName||'',q1:sub.q1||'',q2:sub.q2||'',q3:sub.q3||'',files:sub.files||[],at:sub.at,manual:sub.manual||[],score:sub.score||null}; });
  const _mc=modelCfg();
  return {ok:true,timer:state.timer||null,workshopOpen:!!(state.config&&state.config.workshopOpen),quiz:quizInfo,model:{baseUrl:_mc.base,model:_mc.model,hasKey:!!_mc.key},config:state.config||{},groupsEnabled:groupsOn(),reviewEnabled:reviewOn(),hwCount:hwCountOn(),votePresets:state.votePresets||[],cards:state.cards||[],materials:state.materials||[],rubrics:state.rubrics||{},activeCard:(state.config&&state.config.activeCard)||'',activeCardData:(function(){var c=(state.cards||[]).filter(function(x){return x.id===(state.config&&state.config.activeCard)})[0];return c?{theme:c.theme,type:c.type,content:c.content,attrs:c.attrs}:null;})(),tasks:state.tasks||[],hwOpen:!!(state.config&&state.config.hwOpen),buzz:state.buzz||{enabled:false,running:false,winner:''},students:Object.keys(state.students).map(function(k){const st=Object.assign({key:k},state.students[k]);st.hwScore=Object.keys(state.submissions||{}).filter(function(sk){return sk.indexOf(k+'||')===0}).reduce(function(a,sk){return a+(((state.submissions[sk]||{}).score||{}).total||0)},0);st.quizScore=(((state.quiz&&state.quiz.answers&&state.quiz.answers[k])||{}).score)||0;st.individualScore=Math.round((st.hwScore+st.quizScore)*10)/10;return st}),groups:Object.keys(state.groups).map(g=>({id:g,name:state.groups[g].name,perf:state.groups[g].perf||0,count:counts[g]})),counts,roll:state.roll||{active:false},poll:{active:state.poll.active,question:state.poll.question,options:state.poll.options,votes:state.poll.votes,results,startedAt:state.poll.startedAt},submissions:subs,updatedAt:state.updatedAt};
}
/* 【JSON 解读模块·临时】解析考试结果 JSON，提取评分（总分/等级/姓名/提示次数/各题得分）。
   通用字段名匹配（中/英），兼容不同 JSON 结构；解析不出的字段留 null，raw 保留原始 JSON。
   与 AI+rubric 重新打分并存：本模块只读 JSON 已有分；AI 重评走 aiScoreSubmission 覆盖 sub.score，两者互不冲突。*/
function parseExamJson(text){
  let obj; try{ obj=JSON.parse(text); }catch(e){ return null; }
  const out={ok:true,raw:obj,total:null,grade:null,name:null,hint:null,items:[],at:new Date().toLocaleString('zh-CN')};
  const num=function(v){ return (typeof v==='number'&&isFinite(v))?v:null; };
  (function walk(o){
    if(!o||typeof o!=='object') return;
    if(Array.isArray(o)){ o.forEach(walk); return; }
    const sc0=(o.score!=null)?num(o.score):(o.pts!=null)?num(o.pts):(o.得分!=null)?num(o.得分):(o.point!=null)?num(o.point):null;
    const tt0=(o.t!=null)?o.t:(sc0!==null&&o.name!=null)?o.name:(sc0!==null&&o.id!=null)?o.id:(sc0!==null&&o.title!=null)?o.title:(sc0!==null&&o.task!=null)?o.task:(o.dim!=null)?o.dim:(o.题目!=null)?o.题目:(o.维度!=null)?o.维度:null;
    if(sc0!==null&&tt0!==null&&out.items.length<40) out.items.push({t:String(tt0),score:sc0,desc:o.desc||o.说明||o.reason||''});
    for(const k in o){
      const v=o[k]; const key=String(k).toLowerCase();
      if(out.total===null&&/^(total|totalscore|finalscore|final|score|sum|zongfen|总分|总成绩|得分)$/.test(key)&&num(v)!==null) out.total=num(v);
      if(out.grade===null&&/^(grade|level|band|档次|等级|评级)$/.test(key)&&typeof v==='string') out.grade=v;
      if(out.name===null&&/^(name|姓名|考生|student|candidate|username|用户)$/.test(key)&&typeof v==='string') out.name=v;
      if(out.hint===null&&/^(hint|hints|hintcount|usehints|tips|提示次数)$/.test(key)&&num(v)!==null) out.hint=num(v);
      walk(v);
    }
  })(obj);
  return out;
}
async function aiScoreSubmission(sub,rubric,taskName){
  if(!sub) return {ok:false,error:'submission not found'};
  if(!rubric||!rubric.length) return {ok:false,error:'缺少评分标准'};
  const scenario=String(taskName||sub.task||'').trim();
  const files=(sub.files||[]).map(function(f){return f.name}).join('、');
  const answer=['【作业场景】',scenario||'通用场景','【文件名】',files||'（无文件）','【正文】',String(sub.text||'（空）').slice(0,2500),'【三问】',(sub.q1||''),' / ',(sub.q2||''),' / ',(sub.q3||'')].join('\n');
  const prompt='你是企业 AI 培训的作业评分助教。作业场景：'+(scenario||'通用场景')+'。\n先按这个场景的通用标准判断：学员是否真的解决了业务问题、产物是否可执行、是否有具体依据；下面的评分项只作校准，不要机械按模板勾选。\n评分标准（编号|标准|满分）：\n'+rubric.map(function(c,i){return (i+1)+'|'+c.t+'|'+c.pts}).join('\n')+'\n\n'+answer+'\n\n严格按每行“编号|分数|一句依据”的格式输出，不要标题、不要解释、不要多余文字，分数不超过该项满分。';
  const r=await modelChat([{role:'user',content:prompt}],1600);
  if(!r.ok) return {ok:false,error:r.error};
  const items=[]; let total=0;
  String(r.content).split(/\n+/).forEach(function(line){
    const m=line.match(/^\s*(\d+)\s*[|｜]\s*([0-9.]+)\s*[|｜]?\s*(.*)$/);
    if(!m) return;
    const idx=Number(m[1])-1; const rb=rubric[idx]; if(!rb) return;
    const mx=Number(rb.pts)||0; const sc=Math.max(0,Math.min(mx,Number(m[2])||0));
    items.push({t:rb.t,score:sc,max:mx,why:(m[3]||'').slice(0,80)}); total+=sc;
  });
  if(!items.length) return {ok:false,error:'模型返回无法解析：'+String(r.content).slice(0,200)};
  const cap=rubric.reduce(function(a,c){return a+(Number(c.pts)||0)},0);
  total=Math.round(Math.min(total,cap)*10)/10;
  sub.score={ai:true,total:total,override:total,items:items,model:r.model,at:new Date().toLocaleString('zh-CN')};
  return {ok:true,score:sub.score};
}
function mcpToolDefs(){
  return [
    {name:'room.create',description:'创建课堂房间',inputSchema:{type:'object',properties:{title:{type:'string'}}}},
    {name:'room.list',description:'列出房间',inputSchema:{type:'object',properties:{}}},
    {name:'room.state',description:'读取房间状态',inputSchema:{type:'object',properties:{room:{type:'string'}},required:['room']}},
    {name:'poll.start',description:'发起投票',inputSchema:{type:'object',properties:{room:{type:'string'},question:{type:'string'},options:{type:'array',items:{type:'string'}}},required:['room','question','options']}},
    {name:'poll.stop',description:'结束投票',inputSchema:{type:'object',properties:{room:{type:'string'}},required:['room']}},
    {name:'buzz.start',description:'开始一轮抢答',inputSchema:{type:'object',properties:{room:{type:'string'}},required:['room']}},
    {name:'quiz.publish',description:'按题库发布答题；mode=random 每个学员独立随机卷，seq 统一顺序卷',inputSchema:{type:'object',properties:{room:{type:'string'},mode:{type:'string',enum:['random','seq']},counts:{type:'object'},scores:{type:'object'}}}},
    {name:'score.adjust',description:'调整小组表现分',inputSchema:{type:'object',properties:{room:{type:'string'},group:{type:'string'},delta:{type:'number'}},required:['room','group','delta']}},
    {name:'report.export',description:'导出课堂报告',inputSchema:{type:'object',properties:{room:{type:'string'}},required:['room']}},
    {name:'screen.url',description:'取大屏地址',inputSchema:{type:'object',properties:{room:{type:'string'}},required:['room']}},
    {name:'material.put',description:'导入课程素材。data_base64 写入房间素材库；url 登记外链。返回素材与下载地址。',inputSchema:{type:'object',properties:{room:{type:'string'},name:{type:'string'},filename:{type:'string'},data_base64:{type:'string'},url:{type:'string'},type:{type:'string'},description:{type:'string'}},required:['room','name']}},
    {name:'card.put',description:'导入行动卡或场景卡；带 id 为更新，不带为新增。',inputSchema:{type:'object',properties:{room:{type:'string'},id:{type:'string'},theme:{type:'string'},type:{type:'string'},content:{type:'string'},attrs:{type:'string'}},required:['room','theme']}},
    {name:'votebank.put',description:'导入投票题库；mode=append/replace，presets 为 {question,options[]} 数组。',inputSchema:{type:'object',properties:{room:{type:'string'},mode:{type:'string',enum:['append','replace']},presets:{type:'array',items:{type:'object',properties:{question:{type:'string'},options:{type:'array',items:{type:'string'}}},required:['question','options']}},question:{type:'string'},options:{type:'array',items:{type:'string'}}},required:['room']}},
    {name:'rubric.put',description:'导入作业评分标准；items 为 {t,pts,desc}，按 task 保存。',inputSchema:{type:'object',properties:{room:{type:'string'},task:{type:'string'},items:{type:'array',items:{type:'object',properties:{t:{type:'string'},pts:{type:'number'},desc:{type:'string'}},required:['t','pts']}}},required:['room','task','items']}}

,
    {name:'remote.state',description:'读取遥控器状态：投票、抢答、答题、计时、分组、卡片、素材/作业开关。语音控制前先查状态。',inputSchema:{type:'object',properties:{room:{type:'string'}},required:['room']}},
    {name:'remote.control',description:'执行遥控器操作，适合语音/Agent：material.open/close/toggle、hw.open/close/toggle、screen.set、group.score、roll.start/stop、poll.start/stop、buzz.enable/disable/start/reset、quiz.start/close、timer.start/pause/reset、workshop.open/close、card.push/withdraw。',inputSchema:{type:'object',properties:{room:{type:'string'},action:{type:'string',enum:['material.open','material.close','material.toggle','hw.open','hw.close','hw.toggle','screen.set','group.score','roll.start','roll.stop','poll.start','poll.stop','buzz.enable','buzz.disable','buzz.start','buzz.reset','quiz.start','quiz.close','timer.start','timer.pause','timer.reset','workshop.open','workshop.close','card.push','card.withdraw']},group:{type:'string'},delta:{type:'number'},view:{type:'string',enum:['course','data','report','workshop']},presetId:{type:'string'},question:{type:'string'},options:{type:'array',items:{type:'string'}},cardId:{type:'string'},id:{type:'string'},minutes:{type:'number'},mode:{type:'string',enum:['random','seq']},counts:{type:'object'},scores:{type:'object'}},required:['room','action']}}
  ];
}
function mcpHelpHtml(){
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>YSCOT MCP 接入说明</title><style>
  :root{--bg:#0e0e10;--card:#17171b;--line:#2b2b32;--text:#f4efe2;--muted:#9db3a6;--lime:#cbf74e}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.7 -apple-system,"Microsoft YaHei",sans-serif}
  main{max-width:900px;margin:0 auto;padding:48px 24px 80px}h1{font-size:30px;margin:0 0 8px}h2{font-size:18px;margin:30px 0 8px;color:var(--lime)}
  p,li{color:#d8d2c5}small,.muted{color:var(--muted)}code{background:#22231f;color:#e7f9a6;border-radius:5px;padding:2px 5px}
  pre{background:#111216;border:1px solid var(--line);border-radius:10px;padding:14px;overflow:auto;color:#dce9c4;font:12.5px/1.6 Consolas,monospace}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:18px 0}.warn{border-color:rgba(203,247,78,.45);background:rgba(203,247,78,.07)}
  a{color:var(--lime)}table{width:100%;border-collapse:collapse;margin-top:8px}td,th{border-bottom:1px solid var(--line);padding:7px 8px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:500}
  </style></head><body><main>
  <h1>YSCOT MCP 接入说明</h1>
  <p class="muted">这里是 MCP JSON-RPC 端点，不是普通网页。浏览器直接打开看到这一段是正常的；AI 客户端应使用 POST 请求。</p>
  <div class="card warn"><b>先看这一条：401 unauthorized 不是服务坏了。</b><br>需要在请求头带 <code>Authorization: Bearer &lt;MCP_TOKEN&gt;</code>。登录后在工作台「模型与MCP」页的「MCP 接入令牌」里查看，可复制、可重置；只对当前讲师的场次生效，不要发给外部。</div>
  <h2>1. 客户端配置（通用 MCP HTTP）</h2>
  <pre>{
  "mcpServers": {
    "yscot": {
      "type": "http",
      "url": "https://yscot.clawshell.online/mcp",
      "headers": {
        "Authorization": "Bearer &lt;MCP_TOKEN&gt;"
      }
    }
  }
}</pre>
  <p class="muted">不同客户端的字段名可能略有差异；核心只有两个：URL 和 Authorization 请求头。</p>
  <h2>2. 先用 curl 验证</h2>
  <pre>export MCP_TOKEN='从工作台 → 模型与MCP → MCP 接入令牌 复制'
curl -s https://yscot.clawshell.online/mcp \
  -X POST \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'</pre>
  <p>返回里有 <code>"tools":[ ... ]</code> 就说明令牌和端点都通了。</p>
  <h2>3. 调用一个工具</h2>
  <pre>{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "votebank.put",
    "arguments": {
      "room": "YQ2X",
      "mode": "append",
      "presets": [
        {"question": "你从什么时候开始接触 AI？", "options": ["今天第一次", "半年内", "一到三年", "三年以上"]}
      ]
    }
  }
}</pre>
  <h2>4. 常用内容工具</h2>
  <table><tr><th>工具</th><th>用途</th><th>关键参数</th></tr>
  <tr><td><code>votebank.put</code></td><td>遥控器投票题库</td><td><code>room, mode, presets[{question,options}]</code></td></tr>
  <tr><td><code>material.put</code></td><td>课程素材</td><td><code>room, name, data_base64</code> 或 <code>url</code></td></tr>
  <tr><td><code>card.put</code></td><td>行动卡 / 场景卡</td><td><code>room, theme, type, content, attrs</code></td></tr>
  <tr><td><code>rubric.put</code></td><td>作业评分标准</td><td><code>room, task(T1-T6), items[{t,pts,desc}]</code></td></tr>
  <tr><td><code>quiz.publish</code></td><td>按已有答题题库发布</td><td><code>room, mode(random/seq), counts, scores</code></td></tr>

  <tr><td><code>remote.state</code></td><td>读取遥控器状态</td><td><code>room</code>；返回投票、答题、计时、分组、卡片</td></tr>
  <tr><td><code>remote.control</code></td><td>执行遥控器动作</td><td><code>room, action</code>；如 <code>screen.set</code>、<code>material.toggle</code>、<code>roll.start</code>、<code>poll.start</code>、<code>timer.start</code></td></tr>
  </table>
  <h2>5. 常见错误</h2>
  <table><tr><th>现象</th><th>处理</th></tr>
  <tr><td>401 unauthorized</td><td>到工作台「模型与MCP → MCP 接入令牌」复制；检查是否被重置或多了空格；不要用浏览器 GET 代替 POST。</td></tr>
  <tr><td>工具返回“题库为空”</td><td>先导入 <code>votebank.put</code> 或后台「在线答题」题库；投票题和答题题库不是同一份数据。</td></tr>
  <tr><td>找不到房间</td><td><code>room</code> 必须是 4 位大写场次码，例如 <code>YQ2X</code>。</td></tr>
  <tr><td>素材超过大小</td><td>单个素材 ≤ 10MB；MCP 请求体 ≤ 16MB，建议大文件走 <code>url</code> 外链。</td></tr>
  </table>
  <p class="muted">完整字段与返回示例：<a href="https://github.com/jorinyang/YSCOT/blob/main/docs/09-MCP内容导入标准.md">docs/09-MCP内容导入标准.md</a></p>
  </main></body></html>`;
}

async function mcpHandle(msg, mcpTeacher){
  const id=(msg&&msg.id!==undefined)?msg.id:null;
  const method=msg&&msg.method;
  const reply=function(result){ return {jsonrpc:'2.0',id,result}; };
  if(method==='initialize') return reply({protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'yscot',version:'0.4.0'}});
  if(method==='notifications/initialized') return {jsonrpc:'2.0',id:null,result:{ok:true}};
  if(method==='tools/list') return reply({tools:mcpToolDefs()});
  if(method==='tools/call'){
    const name=msg.params&&msg.params.name; const a=(msg.params&&msg.params.arguments)||{};
    const room=validRoom(a.room)?a.room:DEFAULT_ROOM;
    setRoom(room);
    if(name!=='room.create'&&name!=='room.list'&&!canMcpRoom(mcpTeacher,room)) return reply({isError:true,content:[{type:'text',text:'无权操作该房间：该场次不属于当前令牌的讲师'}]});
    try{
      if(name==='room.create'){ const code=createRoom(a.title,a.city,a.date,mcpTeacher&&mcpTeacher.id,a.province,a.project); return reply({content:[{type:'text',text:JSON.stringify({code,urls:{ops:'/ops?room='+code,screen:'/screen?room='+code}})}]}); }
      if(name==='room.list') return reply({content:[{type:'text',text:JSON.stringify(listRooms(mcpTeacher))}]});
      if(name==='remote.state') return reply({content:[{type:'text',text:JSON.stringify(remoteView())}]});
      if(name==='remote.control'){
        const bad=function(msg){return reply({isError:true,content:[{type:'text',text:msg}]})};
        const act=String(a.action||'');
        state.config=state.config||{};
        if(act.indexOf('material.')===0){ state.config.materialOpen=act==='material.open'?true:act==='material.close'?false:!state.config.materialOpen; save(); }
        else if(act.indexOf('hw.')===0){ state.config.hwOpen=act==='hw.open'?true:act==='hw.close'?false:!state.config.hwOpen; save(); }
        else if(act==='screen.set'){
          let v=String(a.view||'data'); if(v==='report'||v==='stats')v='data'; if(v==='poll')v='data';
          if(['course','data','workshop'].indexOf(v)<0)return bad('view 只支持 course / data / workshop');
          if(v==='data'){ let t=String(a.tab||state.config.screenDataTab||'base'); if(a.view==='poll')t='poll'; if(['base','poll','groups','homework','quiz'].indexOf(t)<0)return bad('tab 只支持 base / poll / groups / homework / quiz'); state.config.screenDataTab=t; }
          state.config.screenView=v; save();
        }
        else if(act==='group.score'){
          if(!groupsOn())return bad('分组抽签已关闭，按个人计分');
          const g=String(a.group||''); if(!state.groups[g])return bad('分组不存在：'+g); const d=Number(a.delta); if(!isFinite(d))return bad('delta 需要是数字');
          state.groups[g].perf=(state.groups[g].perf||0)+d; save();
        }
        else if(act==='roll.start'||act==='roll.stop'){
          state.roll=state.roll||{active:false,key:'',name:'',round:0,at:0};
          if(act==='roll.stop'){state.roll.active=false;save();}
          else{const keys=Object.keys(state.students||{});if(!keys.length)return bad('还没有学员，先让学员扫码进入');const k=keys[Math.floor(Math.random()*keys.length)];const st=state.students[k];state.roll={active:true,key:k,name:(st&&st.name)||'学员',round:(state.roll.round||0)+1,at:Date.now()};save();}
        }
        else if(act==='poll.start'||act==='poll.stop'){
          if(act==='poll.stop'){state.poll.active=false;save();}
          else{
            let q=String(a.question||'').trim(), opts=(a.options||[]).map(String).filter(Boolean);
            if(a.presetId){const p=(state.votePresets||[]).filter(function(x){return x.id===a.presetId})[0];if(!p)return bad('投票预置不存在：'+a.presetId);q=p.question;opts=(p.options||[]).slice();}
            if(!q||opts.length<2)return bad('poll.start 需要 presetId，或 question + 至少两个 options');
            state.poll={active:true,question:q,options:opts,votes:{},startedAt:new Date().toLocaleString('zh-CN')};save();
          }
        }
        else if(act.indexOf('buzz.')===0){
          state.buzz=state.buzz||{enabled:false,running:false,winner:'',at:''};
          if(act==='buzz.enable'){state.buzz.enabled=true;state.buzz.running=false;state.buzz.winner='';state.buzz.winnerKey='';}
          else if(act==='buzz.disable'){state.buzz.enabled=false;state.buzz.running=false;}
          else if(act==='buzz.start'){state.buzz.enabled=true;state.buzz.running=true;state.buzz.winner='';state.buzz.winnerKey='';state.buzz.round=(state.buzz.round||0)+1;state.buzz.at=new Date().toLocaleString('zh-CN');}
          else if(act==='buzz.reset'){state.buzz.running=false;state.buzz.winner='';state.buzz.winnerKey='';}
          else return bad('buzz 动作不支持：'+act);
          save();
        }
        else if(act==='quiz.start'||act==='quiz.close'){
          state.quiz=state.quiz||{bank:{choice:[],judge:[],blank:[],short:[]},answers:{}};
          if(act==='quiz.close'){if(state.quiz.paper)state.quiz.paper.active=false;save();}
          else{
            const prev=state.quiz.config||{};
            const cfg={mode:a.mode==='seq'?'seq':(a.mode==='random'?'random':(prev.mode==='seq'?'seq':'random')),counts:a.counts||prev.counts||{choice:5,judge:3,blank:2,short:1},scores:a.scores||prev.scores||{choice:2,judge:2,blank:3,short:10}};
            const qs=quizBuildPaper(cfg); if(!qs.length)return bad('答题题库为空，或各类数量为 0；请先导入答题题库');
            state.quiz.config=cfg;state.quiz.paper={active:true,at:new Date().toLocaleString('zh-CN'),mode:cfg.mode,counts:cfg.counts,scores:cfg.scores,questions:qs};state.quiz.answers={};state.quiz.papers={};
            if(cfg.mode==='random'){Object.keys(state.students||{}).forEach(function(k){state.quiz.papers[k]=quizBuildPaper(cfg);});}
            save();
          }
        }
        else if(act.indexOf('timer.')===0){
          state.timer=state.timer||{running:false,endAt:0,duration:0};
          if(act==='timer.start'){const min=Math.max(1,Math.min(240,Number(a.minutes)||90));state.timer={running:true,endAt:Date.now()+min*60000,duration:min*60000};}
          else if(act==='timer.pause'){state.timer.running=false;state.timer.endAt=0;}
          else if(act==='timer.reset'){state.timer={running:false,endAt:0,duration:0};}
          else return bad('timer 动作不支持：'+act);
          save();
        }
        else if(act==='workshop.open'||act==='workshop.close'||act==='card.push'||act==='card.withdraw'){
          if(act==='workshop.open'){state.config.workshopOpen=true;save();}
          else if(act==='workshop.close'||act==='card.withdraw'){state.config.workshopOpen=false;state.config.activeCard='';save();}
          else{const cid=String(a.cardId||a.id||'');const card=(state.cards||[]).filter(function(c){return c.id===cid})[0];if(!card)return bad('卡片不存在：'+cid);state.config.activeCard=cid;state.config.workshopOpen=true;save();}
        }
        else return bad('不支持的遥控器动作：'+act);
        return reply({content:[{type:'text',text:JSON.stringify({ok:true,action:act,room:room,state:remoteView()})}]});
      }
      if(name==='room.state') return reply({content:[{type:'text',text:JSON.stringify(screenView())}]});
      if(name==='poll.start'){ state.poll={active:true,question:String(a.question||''),options:(a.options||[]).map(String),votes:{},startedAt:new Date().toLocaleString('zh-CN')}; save(); return reply({content:[{type:'text',text:JSON.stringify({ok:true})}]}); }
      if(name==='poll.stop'){ state.poll.active=false; save(); return reply({content:[{type:'text',text:JSON.stringify({ok:true})}]}); }
      if(name==='buzz.start'){ state.buzz.enabled=true; state.buzz.running=true; state.buzz.winner='';state.buzz.winnerKey=''; state.buzz.round=(state.buzz.round||0)+1; save(); return reply({content:[{type:'text',text:JSON.stringify({ok:true,round:state.buzz.round})}]}); }
      if(name==='quiz.publish'){
        state.quiz=state.quiz||{bank:{choice:[],judge:[],blank:[],short:[]},config:{},answers:{}};
        const cfg={mode:a.mode==='seq'?'seq':'random',counts:a.counts||{choice:5,judge:3,blank:2,short:1},scores:a.scores||{choice:2,judge:2,blank:3,short:10}};
        const qs=quizBuildPaper(cfg);
        if(!qs.length) return reply({isError:true,content:[{type:'text',text:'题库为空'}]});
        state.quiz.paper={active:true,at:new Date().toLocaleString('zh-CN'),mode:cfg.mode,counts:cfg.counts,scores:cfg.scores,questions:qs};
        state.quiz.answers={}; state.quiz.papers={}; state.quiz.config=cfg;
        if(cfg.mode==='random'){ Object.keys(state.students||{}).forEach(function(k){ state.quiz.papers[k]=quizBuildPaper(cfg); }); }
        save();
        return reply({content:[{type:'text',text:JSON.stringify({ok:true,count:qs.length,mode:cfg.mode})}]});
      }
      if(name==='score.adjust'){ if(state.groups[a.group]){ state.groups[a.group].perf=(state.groups[a.group].perf||0)+Number(a.delta||0); save(); } return reply({content:[{type:'text',text:JSON.stringify({ok:true,perf:state.groups[a.group]&&state.groups[a.group].perf})}]}); }
      if(name==='material.put'){
        const nm=String(a.name||'').trim(); if(!nm) return reply({isError:true,content:[{type:'text',text:'name 必填'}]});
        if(a.data_base64){
          const buf=Buffer.from(String(a.data_base64),'base64'); if(!buf.length) return reply({isError:true,content:[{type:'text',text:'data_base64 为空'}]});
          if(buf.length>10*1024*1024) return reply({isError:true,content:[{type:'text',text:'单文件超过 10MB'}]});
          const raw=String(a.filename||nm); const safe=raw.replace(/[^\w.\-\u4e00-\u9fa5]/g,'_');
          const stored=Date.now().toString(36)+'-'+safe; fs.writeFileSync(path.join(roomUploadDir(room),stored),buf);
          let meta={}; try{ meta=JSON.parse(fs.readFileSync(roomMetaFile(room),'utf8')); }catch(e){}
          meta.files=meta.files||[]; meta.files.push({name:nm,stored:stored,size:buf.length,type:String(a.type||raw.split('.').pop()||''),at:new Date().toISOString()});
          fs.writeFileSync(roomMetaFile(room),JSON.stringify(meta,null,1));
          return reply({content:[{type:'text',text:JSON.stringify({ok:true,name:nm,stored:stored,url:'/api/room/file?name='+encodeURIComponent(stored)+'&room='+encodeURIComponent(currentRoom),size:buf.length})}]});
        }
        if(a.url){
          const uu=String(a.url); if(!/^https?:\/\//i.test(uu)) return reply({isError:true,content:[{type:'text',text:'url 必须是 http(s)'}]});
          state.materials=state.materials||[]; const id='m-'+Date.now().toString(36);
          state.materials.push({id:id,name:nm,url:uu,type:String(a.type||'link'),description:String(a.description||''),at:new Date().toISOString()});
          save(); return reply({content:[{type:'text',text:JSON.stringify({ok:true,id:id,name:nm,url:uu})}]});
        }
        return reply({isError:true,content:[{type:'text',text:'需要 data_base64 或 url'}]});
      }
      if(name==='card.put'){
        const theme=String(a.theme||'').trim(); if(!theme) return reply({isError:true,content:[{type:'text',text:'theme 必填'}]});
        state.cards=state.cards||[]; let id=String(a.id||''); let card=id?state.cards.filter(function(x){return x.id===id})[0]:null;
        if(!id){ id='c-'+Date.now().toString(36); card={id:id}; state.cards.push(card); }
        if(!card) return reply({isError:true,content:[{type:'text',text:'卡片不存在'}]});
        card.theme=theme; card.type=String(a.type||card.type||'行动卡'); card.content=String(a.content||''); card.attrs=String(a.attrs||'');
        save(); return reply({content:[{type:'text',text:JSON.stringify({ok:true,id:id})}]});
      }
      if(name==='votebank.put'){
        state.votePresets=state.votePresets||[];
        const list=Array.isArray(a.presets)?a.presets:[{question:a.question,options:a.options}];
        if(a.mode==='replace') state.votePresets=[];
        const ids=[];
        for(const it of list){ const q=String((it&&it.question)||'').trim(); const opts=((it&&it.options)||[]).map(String).filter(function(x){return x.trim()}); if(!q||opts.length<2) continue; const id='v-'+Date.now().toString(36)+'-'+ids.length; state.votePresets.push({id:id,question:q,options:opts}); ids.push(id); }
        if(!ids.length) return reply({isError:true,content:[{type:'text',text:'没有有效题目（question + 至少两个 options）'}]});
        save(); return reply({content:[{type:'text',text:JSON.stringify({ok:true,ids:ids,count:state.votePresets.length})}]});
      }
      if(name==='rubric.put'){
        const task=String(a.task||'').trim(); const items=Array.isArray(a.items)?a.items:[]; if(!task||!items.length) return reply({isError:true,content:[{type:'text',text:'task 与 items 必填'}]});
        state.rubrics=state.rubrics||{}; state.rubrics[task]=items.map(function(x){return {t:String(x.t||''),pts:Number(x.pts)||0,desc:String(x.desc||'')}}); save();
        return reply({content:[{type:'text',text:JSON.stringify({ok:true,task:task,count:items.length})}]});
      }
      if(name==='report.export'){ return reply({content:[{type:'text',text:JSON.stringify({room:currentRoom,students:Object.keys(state.students).length,groups:screenView().groups,quiz:screenView().quiz,poll:screenView().poll})}]}); }
      if(name==='screen.url'){ return reply({content:[{type:'text',text:JSON.stringify({url:'/screen?room='+room})}]}); }
      return reply({isError:true,content:[{type:'text',text:'unknown tool '+name}]});
    }catch(e){ return reply({isError:true,content:[{type:'text',text:String(e.message||e)}]}); }
  }
  return {jsonrpc:'2.0',id,error:{code:-32601,message:'method not found'}};
}
async function dingCorpUser(unionId){
  if(!(DING_ID&&DING_SECRET&&unionId)) return null;
  try{
    const tr=await fetch('https://oapi.dingtalk.com/gettoken?appkey='+encodeURIComponent(DING_ID)+'&appsecret='+encodeURIComponent(DING_SECRET));
    const tj=await tr.json(); if(!tj.access_token) return {ok:false,reason:'token',error:'gettoken 失败'};
    const u1=await fetch('https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token='+tj.access_token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({unionid:unionId})});
    const j1=await u1.json(); const userid=j1.result&&j1.result.userid;
    if(!userid) return {ok:false,reason:'no_permission_or_not_in_org',error:j1.errmsg||('errmsg unavailable, errcode '+(j1.errcode==null?'?':j1.errcode))};
    const u2=await fetch('https://oapi.dingtalk.com/topapi/v2/user/get?access_token='+tj.access_token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userid:userid})});
    const j2=await u2.json(); const r2=j2.result||{};
    return {ok:true,userid:userid,name:r2.name||'',avatar:r2.avatar||'',title:r2.title||'',mobile:r2.mobile||'',dept:(r2.dept_id_list||[]).join('/')};
  }catch(e){ return {ok:false,reason:String(e.message||e)}; }
}
async function dingDeptNames(ids){
  if(!(ids&&ids.length)) return '';
  try{
    const tr=await fetch('https://oapi.dingtalk.com/gettoken?appkey='+encodeURIComponent(DING_ID)+'&appsecret='+encodeURIComponent(DING_SECRET));
    const tj=await tr.json(); if(!tj.access_token) return '';
    const out=[];
    for(const id of ids.slice(0,6)){
      const d=await fetch('https://oapi.dingtalk.com/topapi/v2/department/get?access_token='+tj.access_token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dept_id:Number(id)})});
      const j=await d.json(); if(j.result&&j.result.name) out.push(j.result.name);
    }
    return out.join(' / ');
  }catch(e){ return ''; }
}
async function genJSON(prompt,maxTokens){
  const r=await modelChat([{role:'user',content:prompt}],maxTokens||2600,true);
  if(!r.ok) return {err:r.error};
  let s=String(r.content||'').replace(/^[\s\S]*?\{/,'{').replace(/\}[\s\S]*$/,'}');
  try{ return {data:JSON.parse(s)}; }catch(e){ return {err:'模型返回无法解析'}; }
}

async function genText(prompt,maxTokens){
  let r=await modelChat([{role:'user',content:prompt}],maxTokens||3000);
  if(r.ok && String(r.content||'').trim()) return {text:String(r.content)};
  r=await modelChat([{role:'user',content:prompt}],(maxTokens||3000)+2500);
  if(!r.ok) return {err:r.error};
  return {text:String(r.content||'')};
}
function cleanText(t){ return String(t||'').replace(/```[a-zA-Z]*\n?/g,'').replace(/^\s*markdown\s*$/gim,'').trim(); }
function parseCourseText(t){
  const lines=String(t||'').split(/\r?\n/); let title=''; const secs=[]; let cur=null;
  lines.forEach(function(l){ const s=l.trim(); if(!s)return;
    if(/^#\s+/.test(s)&&!/^##\s+/.test(s)){ title=s.replace(/^#\s+/,''); return; }
    if(/^##\s+/.test(s)){ if(cur)secs.push(cur); cur={type:'bullets',title:s.replace(/^##\s+/,''),items:[]}; return; }
    if(/^[-*]\s+/.test(s)){ if(!cur)cur={type:'bullets',title:'要点',items:[]}; cur.items.push(s.replace(/^[-*]\s+/,'')); return; }
  });
  if(cur)secs.push(cur);
  if(!secs.length) secs.push({type:'bullets',title:'要点',items:lines.filter(Boolean).slice(0,8)});
  return {title:title||'',sections:[{type:'cover',title:title||'课程',text:''}].concat(secs)};
}
function parsePromoText(t){
  const o={headline:'',subline:'',intro:'',modules:[],outcomes:[],schedule:[],cta:''};
  String(t||'').split(/\r?\n/).forEach(function(l){
    let s=l.trim(); if(!s)return;
    let m=s.match(/^(标题|副标题|介绍|模块|收益|安排|行动)[:：]\s*(.+)$/);
    if(m){
      const k=m[1], v=m[2];
      if(k==='标题')o.headline=v;
      else if(k==='副标题')o.subline=v;
      else if(k==='介绍')o.intro=v;
      else if(k==='模块')o.modules.push({title:v,points:[]});
      else if(k==='收益')o.outcomes.push(v);
      else if(k==='安排'){const a=v.split('|');o.schedule.push({time:a[0]||'',text:a[1]||a[0]||''});}
      else if(k==='行动')o.cta=v;
      return;
    }
    if(/^[-*]\s+/.test(s)&&o.modules.length){ o.modules[o.modules.length-1].points.push(s.replace(/^[-*]\s+/,'')); }
  });
  if(!o.headline)o.headline='课程';
  return o;
}
function parseQuizText(t){
  const out={choice:[],judge:[],blank:[],short:[]};
  String(t||'').split(/\r?\n/).forEach(function(l){
    const s=l.trim(); if(!s)return;
    const a=s.split('|').map(function(x){return x.trim()});
    if(a[0]==='选择'&&a.length>=7&&a[1]) out.choice.push({q:a[1],options:[a[2],a[3],a[4],a[5]].filter(Boolean),answer:(a[6]||'A').toUpperCase().replace(/[^A-D]/g,'')||'A'});
    else if(a[0]==='判断'&&a.length>=3&&a[1]) out.judge.push({q:a[1],answer:(a[2].indexOf('错')>=0?'错':'对')});
    else if(a[0]==='填空'&&a.length>=3&&a[1]) out.blank.push({q:a[1],answer:a[2]});
    else if(a[0]==='简答'&&a.length>=3&&a[1]) out.short.push({q:a[1],ref:a[2]});
  });
  return out;
}
function parseHomeworkText(t){
  const out=[];
  cleanText(t).split(/\r?\n/).forEach(function(l){
    let s=l.trim().replace(/^[-*\d.、)\s]+/,''); if(!s)return;
    if(s.indexOf('作业|')>0) s=s.slice(s.indexOf('作业|'));
    const a=s.split('|').map(function(x){return x.trim()});
    if(a[0]==='作业'&&a.length>=4&&a[1]) out.push({title:a[1],scenario:a[2]||'',requirements:(a[3]||'').split(/[;；]/).filter(Boolean),deliverable:a[4]||'',acceptance:a[5]||''});
  });
  return out;
}
function parseMiscText(t){
  const materials=[], homework=[];
  String(t||'').split(/\r?\n/).forEach(function(l){
    const s=l.trim(); if(!s)return;
    const a=s.split('|').map(function(x){return x.trim()});
    if(a[0]==='素材'&&a.length>=3&&a[1]) materials.push({title:a[1],content:a.slice(2).join('\n')});
    else if(a[0]==='作业'&&a.length>=4&&a[1]) homework.push({title:a[1],scenario:a[2]||'',requirements:(a[3]||'').split(/[;；]/).filter(Boolean),deliverable:a[4]||'',acceptance:a[5]||''});
  });
  return {materials:materials,homework:homework};
}
function normalizeQuiz(q){
  const out={choice:[],judge:[],blank:[],short:[]};
  (q.choice||[]).forEach(function(x,i){ const o=(x.options||[]).map(String).filter(Boolean).slice(0,4); if(o.length>=2&&x.q) out.choice.push({id:'choice-gen-'+i,type:'choice',q:String(x.q),options:o,answer:String(x.answer||'A').toUpperCase().replace(/[^A-D]/g,'')||'A'}); });
  (q.judge||[]).forEach(function(x,i){ if(x.q) out.judge.push({id:'judge-gen-'+i,type:'judge',q:String(x.q),answer:(String(x.answer).indexOf('错')>=0?'错':'对')}); });
  (q.blank||[]).forEach(function(x,i){ if(x.q) out.blank.push({id:'blank-gen-'+i,type:'blank',q:String(x.q),answer:String(x.answer||'')}); });
  (q.short||[]).forEach(function(x,i){ if(x.q) out.short.push({id:'short-gen-'+i,type:'short',q:String(x.q),ref:String(x.ref||'')}); });
  return out;
}
function newPackageDir(title){
  fs.mkdirSync(PACKAGES_DIR,{recursive:true});
  const id='pkg-'+Date.now().toString(36);
  const dir=path.join(PACKAGES_DIR,id);
  fs.mkdirSync(path.join(dir,'materials'),{recursive:true});
  fs.writeFileSync(path.join(dir,'meta.json'), JSON.stringify({id,title:title||'课程包',createdAt:new Date().toISOString()},null,1));
  return {id,dir};
}
function renderPromo(meta,p){
  const esc=function(x){return String(x==null?'':x).replace(/[&<>"]/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]})};
  const m=meta||{}, d=p||{};
  const mods=(d.modules||[]).map(function(x){return '<div class="mod"><b>'+esc(x.title)+'</b><ul>'+(x.points||[]).map(function(y){return '<li>'+esc(y)+'</li>'}).join('')+'</ul></div>'}).join('');
  const outs=(d.outcomes||[]).map(function(x){return '<li>'+esc(x)+'</li>'}).join('');
  const sch=(d.schedule||[]).map(function(x){return '<div class="row"><span>'+esc(x.time)+'</span><span>'+esc(x.text)+'</span></div>'}).join('');
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+esc(m.title||d.headline||'课程')+'</title>'
  +'<style>:root{--bg:#081813;--text:#F4EFE2;--muted:#9DB3A6;--amber:#D98A2B;--jade:#2F8F73}*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}'
  +'.wrap{max-width:980px;margin:0 auto;padding:64px 24px}h1{font-size:48px;line-height:1.2;margin-bottom:14px}.sub{font-size:20px;color:#F6E4C6;margin-bottom:24px}.intro{font-size:16px;line-height:1.9;color:#DDE6DE;max-width:720px}'
  +'.k{font-size:12px;letter-spacing:.18em;color:var(--muted);margin:42px 0 14px}.mods{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}.mod{border:1px solid rgba(244,239,226,.13);border-radius:14px;padding:16px;background:rgba(255,255,255,.03)}'
  +'.mod ul{margin:8px 0 0 18px;color:#CFDCD2;line-height:1.8;font-size:14px}ul.clean{list-style:none;line-height:2}.row{display:flex;justify-content:space-between;border-bottom:1px solid rgba(244,239,226,.12);padding:9px 0;font-size:15px}.cta{display:inline-block;margin-top:34px;background:var(--amber);color:#20150A;padding:12px 22px;border-radius:12px;font-weight:700;text-decoration:none}</style></head><body><div class="wrap">'
  +'<h1>'+esc(d.headline||m.title||'课程')+'</h1><div class="sub">'+esc(d.subline||m.subtitle||'')+'</div><p class="intro">'+esc(d.intro||'')+'</p>'
  +'<div class="k">课程模块</div><div class="mods">'+mods+'</div>'
  +'<div class="k">你会得到</div><ul class="clean">'+outs+'</ul>'
  +'<div class="k">时间安排</div>'+sch
  +'<a class="cta" href="#">'+esc(d.cta||'报名/咨询')+'</a></div></body></html>';
}
function roomDir(code){ return code===DEFAULT_ROOM ? path.join(DATA_DIR,'room0') : path.join(ROOMS_DIR,code); }
function renderQuests(tasks){
  return (tasks||[]).map(function(t,i){
    return '<div class="qcard"><b>'+(i+1)+'. '+String(t.title||'作业').replace(/[<>&]/g,'')+'</b>'
      +(t.scenario?('<p>'+String(t.scenario).replace(/[<>&]/g,'')+'</p>'):'')
      +((t.requirements||[]).length?('<ul>'+t.requirements.map(function(x){return '<li>'+String(x).replace(/[<>&]/g,'')+'</li>'}).join('')+'</ul>'):'')
      +(t.deliverable?('<div class="m">交付：'+String(t.deliverable).replace(/[<>&]/g,'')+'</div>'):'')
      +(t.acceptance?('<div class="m">验收：'+String(t.acceptance).replace(/[<>&]/g,'')+'</div>'):'')
      +'</div>';
  }).join('');
}
function xmlText(xml){
  return String(xml||'').replace(/<w:p[ >]/g,'\n<w:p ').replace(/<a:p[ >]/g,'\n<a:p ')
    .replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\n{2,}/g,'\n').trim();
}
function zipRead(buf){
  const entries=[]; let eocd=-1;
  for(let i=buf.length-22;i>=0;i--){ if(buf.readUInt32LE(i)===0x06054b50){ eocd=i; break; } }
  if(eocd<0) throw new Error('不是有效的 zip/docx');
  const n=buf.readUInt16LE(eocd+10); let off=buf.readUInt32LE(eocd+16);
  for(let k=0;k<n;k++){
    if(buf.readUInt32LE(off)!==0x02014b50) break;
    const nameLen=buf.readUInt16LE(off+28), extra=buf.readUInt16LE(off+30), cmt=buf.readUInt16LE(off+32);
    const method=buf.readUInt16LE(off+10), csize=buf.readUInt32LE(off+20), usize=buf.readUInt32LE(off+24);
    const lho=buf.readUInt32LE(off+42), name=buf.toString('utf8',off+46,off+46+nameLen);
    entries.push({name,method,csize,usize,lho});
    off+=46+nameLen+extra+cmt;
  }
  return entries;
}
function zipEntry(buf,entry){
  const lho=entry.lho; const nameLen=buf.readUInt16LE(lho+26), extra=buf.readUInt16LE(lho+28);
  const start=lho+30+nameLen+extra; const data=buf.slice(start,start+entry.csize);
  if(entry.method===0) return data;
  if(entry.method===8) return zlib.inflateRawSync(data);
  throw new Error('不支持的压缩方式');
}
function extractText(filename,buf){
  const ext=String(filename||'').toLowerCase().split('.').pop();
  if(ext==='md'||ext==='txt') return buf.toString('utf8');
  if(ext==='html'||ext==='htm') return buf.toString('utf8').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/\s{2,}/g,' ').trim();
  if(ext==='docx'){ const e=zipRead(buf); const d=e.filter(function(x){return x.name==='word/document.xml'})[0]; if(!d)throw new Error('docx 缺少正文'); return xmlText(zipEntry(buf,d).toString('utf8')); }
  if(ext==='pptx'){ const e=zipRead(buf); const slides=e.filter(function(x){return /^ppt\/slides\/slide\d+\.xml$/.test(x.name)}).sort(function(a,b){return a.name.localeCompare(b.name,undefined,{numeric:true})}); if(!slides.length)throw new Error('pptx 缺少页面'); return slides.map(function(s,i){return '第 '+(i+1)+' 页\n'+xmlText(zipEntry(buf,s).toString('utf8'))}).join('\n\n'); }
  if(ext==='pdf'){ const r=spawnSync('pdftotext',['-','-'],{input:buf}); if(r.error||r.status!==0) throw new Error('服务器未安装 pdftotext，暂不能解析 PDF'); return String(r.stdout||'').trim(); }
  if(ext==='xlsx'){
    const e=zipRead(buf);
    const parts=e.filter(function(x){return x.name==='xl/sharedStrings.xml'||/^xl\/worksheets\/sheet\d+\.xml$/.test(x.name)}).sort(function(a,b){return a.name.localeCompare(b.name,undefined,{numeric:true})});
    if(!parts.length) throw new Error('xlsx 缺少工作表');
    return parts.map(function(x){return xmlText(zipEntry(buf,x).toString('utf8'))}).join('\n').trim();
  }
  return buf.toString('utf8');
}
function renderQuestsPage(tasks){ return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{background:#081813;color:#F4EFE2;font-family:-apple-system,"PingFang SC",sans-serif;padding:16px}.qcard{border:1px solid rgba(244,239,226,.13);border-radius:12px;padding:14px;margin-bottom:10px}.qcard b{color:#F6E4C6}.qcard p,.qcard li{font-size:14px;color:#DDE6DE;line-height:1.7}.qcard ul{margin:6px 0 0 18px}.m{font-size:12px;color:#9DB3A6;margin-top:6px}</style></head><body>'+renderQuests(tasks)+'</body></html>'; }
function ensureRoomAssets(code){ const d=path.join(roomDir(code),'assets'); fs.mkdirSync(d,{recursive:true}); return d; }
function mdToHtml(md){
  const esc=function(x){return String(x).replace(/[&<>]/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c]})};
  const lines=String(md||'').split(/\r?\n/); let out=[]; let inList=false;
  lines.forEach(function(line){
    let s=line;
    if(/^\s*[-*]\s+/.test(s)){ if(!inList){out.push('<ul>');inList=true;} out.push('<li>'+esc(s.replace(/^\s*[-*]\s+/,''))+'</li>'); return; }
    if(inList){ out.push('</ul>'); inList=false; }
    const h=s.match(/^(#{1,3})\s+(.*)$/);
    if(h){ out.push('<h'+h[1].length+'>'+esc(h[2])+'</h'+h[1].length+'>'); return; }
    if(!s.trim()){ out.push(''); return; }
    out.push('<p>'+esc(s).replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>')+'</p>');
  });
  if(inList) out.push('</ul>');
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>课程大纲</title><style>body{background:#081813;color:#F4EFE2;font-family:-apple-system,"PingFang SC",sans-serif;max-width:860px;margin:0 auto;padding:40px 24px;line-height:1.9}h1,h2,h3{color:#F6E4C6;margin:1.2em 0 .5em}p,li{color:#DDE6DE}</style></head><body>'+out.join('\n')+'</body></html>';
}
function roomUploadDir(code){ const d=path.join(roomDir(code),'uploads'); fs.mkdirSync(d,{recursive:true}); return d; }
function savePackage(title, html){
  fs.mkdirSync(PACKAGES_DIR,{recursive:true});
  const id='pkg-'+Date.now().toString(36);
  const dir=path.join(PACKAGES_DIR,id);
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'index.html'), html, 'utf8');
  fs.writeFileSync(path.join(dir,'meta.json'), JSON.stringify({id,title,createdAt:new Date().toISOString()},null,1));
  return id;
}
function listPackages(){
  if(!fs.existsSync(PACKAGES_DIR)) return [];
  return fs.readdirSync(PACKAGES_DIR).filter(d=>/^pkg-[a-z0-9]+$/.test(d)).map(function(d){
    let m={}; try{ m=JSON.parse(fs.readFileSync(path.join(PACKAGES_DIR,d,'meta.json'),'utf8')); }catch(e){}
    return {id:d,title:m.title||d,createdAt:m.createdAt||'',url:'/pkg/'+d+'/index.html'};
  }).sort(function(a,b){return String(b.createdAt).localeCompare(String(a.createdAt))});
}
function screenView(){
  const poll=state.poll||{};
  const results={};
  if(poll.options) poll.options.forEach((o,i)=>{results[i]=0});
  Object.values(poll.votes||{}).forEach(v=>{ if(results[v]!==undefined) results[v]++ });
  const quiz=state.quiz||{};
  const paper=quiz.paper;
  const cfg=state.config||{};
  let _meta=cachedRoomMeta(currentRoom);
  const _tasks=(state.tasks&&state.tasks.length)?state.tasks:[{id:'T1',title:'活动策划方案'},{id:'T2',title:'表格协作'},{id:'T3',title:'汇报与推介 PPT'},{id:'T4',title:'对外宣传'},{id:'T5',title:'项目协作'},{id:'T6',title:'对外核对'}];
  const _subs=Object.keys(state.submissions||{}).map(function(k){
    const p=k.split('||'); const st=state.students[p[0]]||{}; const sub=state.submissions[k]||{};
    return {key:k,name:st.name||p[0],tail:st.tail||'',task:p[1],total:((sub.score||{}).total||0),scored:!!(sub.score&&sub.score.total!=null),files:(sub.files||[]).length,at:sub.at||''};
  });
  const _byTask={};
  _tasks.slice(0,hwCountOn()).forEach(function(t){ _byTask[t.id]={id:t.id,title:t.title||t.id,count:0,scored:0,total:0,avg:0}; });
  _subs.forEach(function(x){ if(!_byTask[x.task])return; _byTask[x.task].count++; if(x.scored){_byTask[x.task].scored++;_byTask[x.task].total+=x.total;} });
  Object.keys(_byTask).forEach(function(t){ const x=_byTask[t]; x.avg=x.scored?Math.round(x.total/x.scored*10)/10:0; x.total=Math.round(x.total*10)/10; });
  const _students=Object.keys(state.students||{}).map(function(k){
    const st=state.students[k]||{};
    const hw=_subs.filter(function(x){return x.key.indexOf(k+'||')===0}).reduce(function(a,x){return a+x.total},0);
    const qs=(((quiz.answers||{})[k])||{}).score||0;
    return {key:k,name:st.name||k,tail:st.tail||'',group:st.group||'',votes:st.votes||0,buzzes:st.buzzes||0,hwScore:Math.round(hw*10)/10,quizScore:qs,individualScore:Math.round((hw+qs)*10)/10};
  });
  const _indivTop=_students.slice().sort(function(a,b){return b.individualScore-a.individualScore||b.buzzes-a.buzzes}).slice(0,12);
  const _quizTop=Object.keys(quiz.answers||{}).map(function(k){const a=quiz.answers[k]||{};const st=state.students[k]||{};return {name:st.name||k,tail:st.tail||'',score:a.score||0,total:a.total||0};}).sort(function(a,b){return b.score-a.score}).slice(0,12);
  const _quizVals=Object.values(quiz.answers||{});
  return {ok:true,room:currentRoom,title:_meta.title||('课堂 '+currentRoom),at:Date.now(),groupsEnabled:groupsOn(),reviewEnabled:reviewOn(),hwCount:hwCountOn(),screenView:(cfg.screenView)||'data',screenDataTab:(function(){var t=String(cfg.screenDataTab||'base');return ['base','poll','groups','homework','quiz'].indexOf(t)>=0?t:'base'})(),slide:cfg.slide||0,packageId:_meta.packageId||'',materialOpen:!!cfg.materialOpen,hwOpen:!!cfg.hwOpen,workshopOpen:!!cfg.workshopOpen,
    meta:{title:_meta.title||('课堂 '+currentRoom),date:_meta.date||'',city:_meta.city||'',province:_meta.province||'',project:_meta.project||''},
    groups:Object.keys(state.groups||{}).map(function(g){return {id:g,name:state.groups[g].name,perf:state.groups[g].perf||0,count:_students.filter(function(s){return s.group===g}).length}}),
    students:_students.length,individualTop:_indivTop,
    files:(_meta.files||[]).map(function(f){return {name:f.name,url:'/api/room/file?name='+encodeURIComponent(f.stored)+'&room='+encodeURIComponent(currentRoom)}}),
    timer:{running:!!(state.timer&&state.timer.running),endAt:(state.timer&&state.timer.endAt)||0,left:(state.timer&&state.timer.running)?Math.max(0,state.timer.endAt-Date.now()):0},
    poll:{active:!!poll.active,question:poll.question||'',options:poll.options||[],results,count:Object.keys(poll.votes||{}).length},
    buzz:{enabled:!!(state.buzz&&state.buzz.enabled),running:!!(state.buzz&&state.buzz.running),winner:(state.buzz&&state.buzz.winner)||'',winnerKey:(state.buzz&&state.buzz.winnerKey)||'',round:(state.buzz&&state.buzz.round)||0},
    quiz:paper?{active:!!paper.active,count:paper.questions.length,points:paper.questions.reduce(function(a,b){return a+(b.score||0)},0),answered:Object.keys(quiz.answers||{}).length,avg:_quizVals.length?Math.round(_quizVals.reduce(function(a,b){return a+(b.score||0)},0)/_quizVals.length*10)/10:0,top:_quizTop}:null,
    homework:{count:_subs.length,total:Math.round(_subs.reduce(function(a,x){return a+x.total},0)*10)/10,byTask:Object.keys(_byTask).map(function(t){return _byTask[t]})},
    activeCard:(cfg.activeCard||''),activeCardData:(function(){var c=(state.cards||[]).filter(function(x){return x.id===cfg.activeCard})[0];return c?{theme:c.theme,type:c.type,content:c.content,attrs:c.attrs}:null})()
  };
}
function send(res,code,obj,type='application/json; charset=utf-8'){ const raw=Buffer.isBuffer(obj)||typeof obj==='string'?obj:JSON.stringify(obj); const body=Buffer.isBuffer(raw)?raw:Buffer.from(String(raw)); res.writeHead(code,{'Content-Type':type,'Content-Length':body.length,'Cache-Control':'no-store','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization, X-MCP-Token','Access-Control-Allow-Methods':'GET,POST,OPTIONS'}); res.end(body); }
function readRaw(req, limit){
  return new Promise((resolve,reject)=>{ const chunks=[]; let n=0; const max=limit||8*1024*1024;
    req.on('data',c=>{ n+=c.length; if(n>max){ reject(new Error('too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end',()=>resolve(Buffer.concat(chunks))); req.on('error',reject); });
}
function readBody(req,max){ const limit=Number(max)||2e6; return new Promise((resolve,reject)=>{ let d=''; req.on('data',c=>{d+=c; if(d.length>limit){reject(new Error('too large'));req.destroy()}}); req.on('end',()=>{ try{resolve(d?JSON.parse(d):{})}catch(e){resolve({})} }); req.on('error',reject); }); }
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.json':'application/json; charset=utf-8','.csv':'text/csv; charset=utf-8','.mp4':'video/mp4','.webm':'video/webm','.jpg':'image/jpeg'};
const MAP=_IS_KIT
  ? {'/':'promo.html','/promo':'promo.html','/live':'live.html','/live.html':'live.html','/course':'course/course.html','/course.html':'course/course.html','/grader':'course/grader.html','/grader.html':'course/grader.html','/admin':'course/admin.html','/admin.html':'course/admin.html','/ops':'course/admin.html','/join':'live.html','/screen':'screen.html','/course-screen':'course-screen.html','/remote':'remote.html','/login':'login.html','/shell':'course-shell.html','/teachers':'teachers.html','/packages':'packages.html','/report':'report.html','/package-edit':'package-edit.html','/room':'room.html','/home':'home.html','/room-setup':'room-setup.html','/demo':'demo.html','/architecture':'architecture.html','/scene':'scene.html'}
  : {'/':'宣传页/课程大纲-宣传版.html','/promo':'宣传页/课程大纲-宣传版.html','/live':'宣传页/live.html','/live.html':'宣传页/live.html','/course':'课件/course.html','/course.html':'课件/course.html','/grader':'课件/grader.html','/grader.html':'课件/grader.html','/admin':'课件/admin.html','/admin.html':'课件/admin.html','/ops':'课件/admin.html','/join':'宣传页/live.html','/screen':'screen.html','/remote':'remote.html','/login':'login.html','/shell':'course-shell.html','/teachers':'teachers.html','/packages':'packages.html','/report':'report.html','/package-edit':'package-edit.html','/room':'room.html','/home':'home.html','/room-setup':'room-setup.html','/demo':'demo.html','/architecture':'architecture.html','/scene':'scene.html'};
function serveStatic(res,pathname){
  let rel=MAP[pathname] || decodeURIComponent(pathname).replace(/^\/+/,'');
  const abs=path.resolve(ROOT,rel);
  if(!abs.startsWith(ROOT)) return send(res,403,{ok:false,error:'forbidden'});
  fs.readFile(abs,(err,buf)=>{ if(err) return send(res,404,'not found','text/plain; charset=utf-8'); send(res,200,buf,MIME[path.extname(abs).toLowerCase()]||'application/octet-stream'); });
}
const server=http.createServer(async (req,res)=>{
  const u=new URL(req.url,'http://x');
  const p=u.pathname;
  if(req.method==='OPTIONS') return send(res,204,'');
  const roomQ=u.searchParams.get('room');
  setRoom(roomQ || cookieRoom(req) || DEFAULT_ROOM);
  if(roomQ && validRoom(roomQ)) res.setHeader('Set-Cookie','gtsc_room='+roomQ+'; Path=/; SameSite=Lax');
  if(p==='/embed.js'){
    const js="(function(){var s=document.currentScript;var room=(s.getAttribute('data-room')||'').toUpperCase();var w=s.getAttribute('data-widget')||'poll';var h=Number(s.getAttribute('data-height')||360);var f=document.createElement('iframe');f.src='/embed?room='+room+'&widget='+w;f.style.cssText='width:100%;height:'+h+'px;border:0;border-radius:12px;background:#081813';s.parentNode.insertBefore(f,s.nextSibling);})();";
    return send(res,200,js,'text/javascript; charset=utf-8');
  }
  if(p==='/embed') return send(res,200,fs.readFileSync(path.join(__dirname,'embed.html')),'text/html; charset=utf-8');
  if((p==='/rooms'||p==='/rooms.html') && req.method==='GET'){
    res.writeHead(302,{'Location':'/home','Cache-Control':'no-store'}); return res.end();
  }
  if(p==='/mcp'){
    if(req.method!=='POST'){
      if(req.method==='GET'){
        if(String(req.headers.accept||'').indexOf('text/event-stream')>=0) return send(res,405,{jsonrpc:'2.0',error:{code:-32600,message:'本端点不支持 GET SSE；请用 POST JSON-RPC'},id:null});
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}); return res.end(mcpHelpHtml());
      }
      return send(res,405,{jsonrpc:'2.0',error:{code:-32600,message:'MCP 只接受 POST JSON-RPC'},id:null});
    }
    const auth=String(req.headers.authorization||'');
    const bearer=auth.indexOf('Bearer ')===0?auth.slice(7).trim():'';
    let mcpTeacher=teacherByMcpToken(bearer);
    if(!mcpTeacher&&process.env.MCP_TOKEN&&bearer===process.env.MCP_TOKEN) mcpTeacher={id:'local',name:'服务令牌',role:'admin'};
    if(!mcpTeacher) return send(res,401,{jsonrpc:'2.0',error:{code:-32001,message:'unauthorized: 请使用工作台「模型与MCP → MCP 接入令牌」里的个人 token，并放在 Authorization: Bearer 后'},id:null});
    const body=await readBody(req,16*1024*1024);
    const reply=await mcpHandle(body,mcpTeacher);
    return send(res,200,reply);
  }
  if(p==='/api/auth/config') return send(res,200,{ok:true,dingtalk:!!(DING_ID&&DING_SECRET),local:!!LOCAL_PASSWORD,required:AUTH_REQUIRED});
  if(p==='/auth/local' && req.method==='POST'){
    const b=await readBody(req);
    if(!LOCAL_PASSWORD) return send(res,400,{ok:false,error:'未配置本地口令'});
    if(String(b.password||'')!==LOCAL_PASSWORD) return send(res,401,{ok:false,error:'口令不对'});
    const t={id:'local',name:'本地讲师',role:'admin'};
    setTeacherCookie(res,t); return send(res,200,{ok:true,teacher:t});
  }
  if(p==='/auth/dingtalk'){
    if(!(DING_ID&&DING_SECRET)) return send(res,501,{ok:false,error:'未配置钉钉应用'});
    const host=(req.headers.host||'').split(':')[0];
    const proto=(req.headers['x-forwarded-proto']||((host==='localhost'||host==='127.0.0.1')?'http':'https')).split(',')[0];
    const allowedHost=/(^|\.)clawshell\.online$/.test(host)||host==='localhost'||host==='127.0.0.1';
    const origin=allowedHost?(proto+'://'+host):(process.env.PUBLIC_URL||u.origin).replace(/\/$/,'');
    const redirect=origin+'/auth/dingtalk/callback';
    const target='https://login.dingtalk.com/oauth2/auth?redirect_uri='+encodeURIComponent(redirect)+'&response_type=code&client_id='+encodeURIComponent(DING_ID)+'&scope=openid&prompt=consent&state=gtsc';
    res.writeHead(302,{Location:target}); return res.end();
  }
  if(p==='/auth/dingtalk/callback'){
    if(!(DING_ID&&DING_SECRET)) return send(res,501,{ok:false,error:'未配置钉钉应用'});
    const code=u.searchParams.get('authCode')||u.searchParams.get('code')||'';
    try{
      const tr=await fetch('https://api.dingtalk.com/v1.0/oauth2/userAccessToken',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId:DING_ID,clientSecret:DING_SECRET,code,grantType:'authorization_code'})});
      const tj=await tr.json();
      if(!tj.accessToken) return send(res,401,'钉钉授权失败','text/html; charset=utf-8');
      const ur=await fetch('https://api.dingtalk.com/v1.0/contact/users/me',{headers:{'x-acs-dingtalk-access-token':tj.accessToken}});
      const me=await ur.json();
      if(tj.idToken||tj.id_token){ try{ const claims=JSON.parse(Buffer.from(String(tj.idToken||tj.id_token).split('.')[1]||'','base64url').toString()); me.unionId=me.unionId||claims.unionId||claims.unionid||''; me.openId=me.openId||claims.openId||claims.openid||''; me.nick=me.nick||claims.nick||claims.name||''; me.avatarUrl=me.avatarUrl||claims.avatarUrl||claims.avatar||''; }catch(e){} }
      let corpInfo=null;
      if(process.env.DINGTALK_CORP_ID){ try{ corpInfo=await dingCorpUser(me.unionId); }catch(e){} }
      if(corpInfo&&corpInfo.name&&!me.nick) me.nick=corpInfo.name;
      const uid=me.unionId||me.openId||'';
      if(corpInfo&&corpInfo.dept) me._dept=corpInfo.dept;
      const teachers=loadTeachers();
      let t=teachers.filter(x=>(uid&&(x.dingUnionId===uid||x.dingOpenId===uid))||(!uid&&x.id==='t-bootstrap'))[0];
      if(!t && uid){ const orphans=teachers.filter(x=>!x.dingUnionId&&!x.dingOpenId); t=orphans.find(x=>x.id==='t-bootstrap')||orphans.find(x=>x.name===me.nick)||(orphans.length===1?orphans[0]:null); }
      if(!t && teachers.length===0){
        t={id:'t-bootstrap',name:me.nick||'首位讲师',role:'admin',dept:'',dingUnionId:me.unionId||'',dingOpenId:me.openId||'',avatar:me.avatarUrl||'',createdAt:new Date().toISOString()};
        teachers.push(t);
      }
      if(!t){
        t={id:'t-'+Date.now().toString(36),name:me.nick||'钉钉讲师',role:'teacher',dept:'',dingUnionId:me.unionId||'',dingOpenId:me.openId||'',avatar:me.avatarUrl||'',createdAt:new Date().toISOString()};
        teachers.push(t);
      }
      let changed=false;
      if(me.unionId && !t.dingUnionId){ t.dingUnionId=me.unionId; changed=true; }
      if(me.openId && !t.dingOpenId){ t.dingOpenId=me.openId; changed=true; }
      if(me.avatarUrl && !t.avatar){ t.avatar=me.avatarUrl; changed=true; }
      if(corpInfo && corpInfo.ok){
        try{ const ids=String(corpInfo.dept||'').split('/').map(function(x){return Number(x)}).filter(Boolean); if(ids.length){ const names=await dingDeptNames(ids); if(names) corpInfo.dept=names; } }catch(e){}
        if(corpInfo.userid && t.dingUserId!==corpInfo.userid){ t.dingUserId=corpInfo.userid; changed=true; }
        if(corpInfo.name && t.name!==corpInfo.name){ t.name=corpInfo.name; changed=true; }
        if(corpInfo.avatar && t.avatar!==corpInfo.avatar){ t.avatar=corpInfo.avatar; changed=true; }
        if(corpInfo.title && t.title!==corpInfo.title){ t.title=corpInfo.title; changed=true; }
        if(corpInfo.mobile && !t.mobile){ t.mobile=corpInfo.mobile; changed=true; }
        if(corpInfo.dept && !t.dept){ t.dept=corpInfo.dept; changed=true; }
        if(t.dingError){ delete t.dingError; changed=true; }
      }else if(corpInfo && !corpInfo.ok && corpInfo.error){
        if(t.dingError!==corpInfo.error){ t.dingError=corpInfo.error; changed=true; }
      }
      if((!t.name||t.name==='首位讲师') && me.nick){ t.name=me.nick; changed=true; }
      if(!t.dept){ const dept=(corpInfo&&corpInfo.dept)||await dingDept(me.unionId); if(dept){ t.dept=dept; changed=true; } }
      if(changed) saveTeachers(teachers);
      setTeacherCookie(res,t);
      res.writeHead(302,{Location:'/home'}); return res.end();
    }catch(e){ return send(res,500,'钉钉登录失败：'+String(e.message||e),'text/html; charset=utf-8'); }
  }
  if(p==='/auth/logout'){ res.setHeader('Set-Cookie','gtsc_teacher=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'); res.writeHead(302,{Location:'/'}); return res.end(); }
  if(p==='/api/dingtalk/refresh' && req.method==='POST'){
    const t=freshTeacher(getTeacher(req)); if(!t||!t.dingUnionId) return send(res,400,{ok:false,error:'当前账号没有 unionId'});
    const info=await dingCorpUser(t.dingUnionId);
    if(!info||!info.ok) return send(res,400,{ok:false,error:(info&&info.error)||'钉钉信息读取失败'});
    const list=loadTeachers(); const m=list.filter(function(x){return x.id===t.id||x.dingUnionId===t.dingUnionId})[0];
    if(!m) return send(res,404,{ok:false,error:'讲师记录不存在'});
    if(info.name) m.name=info.name; if(info.avatar) m.avatar=info.avatar; if(info.userid) m.dingUserId=info.userid; if(info.title) m.title=info.title;
    try{ const ids=String(info.dept||'').split('/').map(function(x){return Number(x)}).filter(Boolean); if(ids.length){ const names=await dingDeptNames(ids); m.dept=names||info.dept||m.dept; } }catch(e){ m.dept=info.dept||m.dept; }
    saveTeachers(list); setTeacherCookie(res,m);
    return send(res,200,{ok:true,teacher:m});
  }
  if(p==='/api/dingtalk/debug' && req.method==='GET'){ return send(res,200,{ok:true,last:global.__lastDingLogin||null}); }
  if(p==='/api/dingtalk/diag' && req.method==='GET'){
    const now=Date.now();
    const fresh=u.searchParams.get('fresh')==='1';
    if(!fresh && global.__dingDiag && now-global.__dingDiag.at<60000) return send(res,200,global.__dingDiag.data);
    const out={ok:false,configured:!!(DING_ID&&DING_SECRET)};
    try{
      const tr=await fetch('https://oapi.dingtalk.com/gettoken?appkey='+encodeURIComponent(DING_ID)+'&appsecret='+encodeURIComponent(DING_SECRET));
      const tj=await tr.json(); out.token=!!tj.access_token;
      if(tj.access_token){
        const u1=await fetch('https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token='+tj.access_token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({unionid:'gtscdt-diagnostic'})});
        const j1=await u1.json(); out.errcode=j1.errcode; out.errmsg=j1.errmsg||'';
        const missing=/60011|qyapi_get_member/.test(out.errmsg)||j1.errcode===88;
        out.permission=!missing;
        out.ok=!!tj.access_token && !missing;
        if(missing) fromErrMsg(j1.errmsg);
      }
    }catch(e){ out.error=String(e.message||e); }
    function fromErrMsg(msg){ const m=String(msg||'').match(/https:\/\/open-dev\.dingtalk\.com\/appscope\/apply\?[^\s,]+/); if(m) out.applyUrl=m[0]; }
    global.__dingDiag={at:now,data:out};
    return send(res,200,out);
  }
  if(p==='/api/me/mcp-token'){
    const t=freshTeacher(getTeacher(req)); if(!t) return send(res,401,{ok:false,error:'请先登录'});
    if(req.method==='GET'){ const rec=ensureMcpToken(t); return send(res,200,{ok:true,token:rec.token,name:t.name||'',updatedAt:rec.updatedAt}); }
    if(req.method==='POST'){
      const b=await readBody(req);
      if(b.action!=='reset') return send(res,400,{ok:false,error:'action 必须是 reset'});
      const rec=resetMcpToken(t); return send(res,200,{ok:true,token:rec.token,name:t.name||'',updatedAt:rec.updatedAt});
    }
    return send(res,405,{ok:false,error:'method not allowed'});
  }
  if(p==='/api/me'){ const t=getTeacher(req); const f=freshTeacher(t); if(f){ try{ setTeacherCookie(res,f); }catch(e){} } return send(res,200,{ok:true,teacher:f}); }
  if(p==='/api/teachers' && req.method==='GET') return send(res,200,{ok:true,teachers:loadTeachers()});
  if(p==='/api/teachers' && req.method==='POST'){
    const b=await readBody(req);
    const name=String(b.name||'').trim(); if(!name) return send(res,400,{ok:false,error:'缺少姓名'});
    const list=loadTeachers();
    const t={id:'t-'+Date.now().toString(36),name,role:['admin','teacher','assistant','viewer'].indexOf(b.role)>=0?b.role:'teacher',dept:String(b.dept||''),dingUnionId:String(b.dingUnionId||''),dingOpenId:String(b.dingOpenId||''),createdAt:new Date().toISOString()};
    list.push(t); saveTeachers(list); return send(res,200,{ok:true,teacher:t});
  }
  if(p==='/api/teachers/update' && req.method==='POST'){
    const b=await readBody(req); const list=loadTeachers(); const t=list.filter(function(x){return x.id===b.id})[0];
    if(!t) return send(res,404,{ok:false,error:'not found'});
    ['name','role','dept','dingUnionId','dingOpenId'].forEach(function(k){ if(b[k]!==undefined) t[k]=String(b[k]||''); });
    saveTeachers(list); return send(res,200,{ok:true,teacher:t});
  }
  if(p==='/api/teachers/delete' && req.method==='POST'){
    const b=await readBody(req); const list=loadTeachers().filter(x=>x.id!==b.id); saveTeachers(list);
    return send(res,200,{ok:true});
  }
  if(p==='/api/room/upload' && req.method==='POST'){
    const b=await readBody(req,42*1024*1024); // 30MB 文件的 base64 会到 40MB，默认 2MB 上限会把请求掐断成 502
    try{
      const buf=Buffer.from(String(b.data||''),'base64');
      if(!buf.length) return send(res,400,{ok:false,error:'空文件'});
      if(buf.length>30*1024*1024) return send(res,413,{ok:false,error:'文件超过 30MB'});
      const raw=String(b.filename||'file.bin');
      const ext=(raw.split('.').pop()||'bin').toLowerCase();
      const safe=raw.replace(/[^\w.\-\u4e00-\u9fa5]/g,'_');
      const stored=Date.now().toString(36)+'-'+safe;
      const dir=roomUploadDir(currentRoom);
      fs.writeFileSync(path.join(dir,stored),buf);
      let meta={}; try{ meta=JSON.parse(fs.readFileSync(roomMetaFile(currentRoom),'utf8')); }catch(e){}
      meta.files=meta.files||[]; meta.files.push({name:raw,stored,size:buf.length,type:ext,at:new Date().toISOString(),released:!b.material,batch:0});
      fs.writeFileSync(roomMetaFile(currentRoom),JSON.stringify(meta,null,1));
      clearRoomMetaCache(currentRoom);
    return send(res,200,{ok:true,name:raw,stored,size:buf.length,url:'/api/room/file?name='+encodeURIComponent(stored)+'&room='+encodeURIComponent(currentRoom)});
    }catch(e){ return send(res,400,{ok:false,error:String(e.message||e)}); }
  }
  if(p==='/api/room/deletefile' && req.method==='POST'){
    const b=await readBody(req); const stored=String(b.stored||'');
    if(!stored||stored.indexOf('/')>=0||stored.indexOf('..')>=0) return send(res,400,{ok:false,error:'文件名不对'});
    let meta={}; try{ meta=JSON.parse(fs.readFileSync(roomMetaFile(currentRoom),'utf8')); }catch(e){}
    const files=(meta.files||[]); const idx=files.findIndex(function(f){return f.stored===stored});
    if(idx<0) return send(res,404,{ok:false,error:'文件不存在'});
    try{ fs.unlinkSync(path.join(roomUploadDir(currentRoom),stored)); }catch(e){}
    files.splice(idx,1); meta.files=files; fs.writeFileSync(roomMetaFile(currentRoom),JSON.stringify(meta,null,1)); clearRoomMetaCache(currentRoom);
    return send(res,200,{ok:true});
  }
  if(p==='/api/room/renamefile' && req.method==='POST'){
    const b=await readBody(req); const stored=String(b.stored||''); const name=String(b.name||'').trim();
    if(!stored||stored.indexOf('/')>=0||stored.indexOf('..')>=0||!name) return send(res,400,{ok:false,error:'参数不对'});
    let meta={}; try{ meta=JSON.parse(fs.readFileSync(roomMetaFile(currentRoom),'utf8')); }catch(e){}
    const files=(meta.files||[]); const f=files.filter(function(x){return x.stored===stored})[0];
    if(!f) return send(res,404,{ok:false,error:'文件不存在'});
    f.name=name.slice(0,120); fs.writeFileSync(roomMetaFile(currentRoom),JSON.stringify(meta,null,1)); clearRoomMetaCache(currentRoom);
    return send(res,200,{ok:true});
  }
  if(p==='/api/room/file'){
    const name=String(u.searchParams.get('name')||'');
    if(!name||name.indexOf('/')>=0||name.indexOf('..')>=0) return send(res,404,'not found','text/plain');
    const f=path.join(roomUploadDir(currentRoom),name);
    if(!fs.existsSync(f)) return send(res,404,'not found','text/plain');
    const ext=(name.split('.').pop()||'').toLowerCase();
    const ct=ext==='pdf'?'application/pdf':ext==='pptx'?'application/vnd.openxmlformats-officedocument.presentationml.presentation':ext==='docx'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':(ext==='html'||ext==='htm')?'text/html; charset=utf-8':'application/octet-stream';
    const hdr={'Content-Type':ct,'Content-Disposition':'inline','Cache-Control':'no-store'};
    if(ext==='html'||ext==='htm') hdr['Content-Security-Policy']="sandbox allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock";
    res.writeHead(200,hdr);
    return res.end(fs.readFileSync(f));
  }
  if(p==='/api/room/markdown' && req.method==='POST'){
    const b=await readBody(req); const text=String(b.text||'');
    if(!text.trim()) return send(res,400,{ok:false,error:'缺少内容'});
    const dir=ensureRoomAssets(currentRoom);
    const base='syllabus-'+Date.now().toString(36);
    fs.writeFileSync(path.join(dir,base+'.html'), mdToHtml(text));
    let _m={}; try{_m=JSON.parse(fs.readFileSync(roomMetaFile(currentRoom),'utf8'));}catch(e){} _m.frameworkUrl='/api/room/asset?name='+base; fs.writeFileSync(roomMetaFile(currentRoom),JSON.stringify(_m,null,1));
    return send(res,200,{ok:true,url:'/api/room/asset?name='+base});
  }
  if(p==='/api/extract' && req.method==='POST'){
    const b=await readBody(req,21*1024*1024); // 15MB 文件的 base64 约 20MB，默认 2MB 不够
    try{
      const buf=Buffer.from(String(b.data||''),'base64');
      if(!buf.length) return send(res,400,{ok:false,error:'空文件'});
      if(buf.length>15*1024*1024) return send(res,413,{ok:false,error:'文件超过 15MB'});
      const text=extractText(b.filename,buf);
      return send(res,200,{ok:true,filename:b.filename,chars:text.length,text:text.slice(0,200000)});
    }catch(e){ return send(res,400,{ok:false,error:String(e.message||e)}); }
  }
  if(p==='/api/generate/apply-homework' && req.method==='POST'){
    const b=await readBody(req); const id=String(b.pkg||'');
    if(!/^pkg-[a-z0-9]+$/.test(id)) return send(res,400,{ok:false,error:'bad package'});
    let hw=[]; try{ hw=JSON.parse(fs.readFileSync(path.join(PACKAGES_DIR,id,'homework.json'),'utf8')); }catch(e){}
    if(!Array.isArray(hw)||!hw.length) return send(res,400,{ok:false,error:'该课程包没有作业题'});
    state.tasks=hw.map(function(t,i){ return {id:'HW'+(i+1),title:String(t.title||('作业 '+(i+1))),scenario:String(t.scenario||''),requirements:(t.requirements||[]).map(String),deliverable:String(t.deliverable||''),acceptance:String(t.acceptance||'')}; });
    let _m={}; try{_m=JSON.parse(fs.readFileSync(roomMetaFile(currentRoom),'utf8'));}catch(e){} _m.packageId=id; fs.writeFileSync(roomMetaFile(currentRoom),JSON.stringify(_m,null,1));
    const ad=ensureRoomAssets(currentRoom);
    fs.writeFileSync(path.join(ad,'quests.html'), renderQuestsPage(state.tasks));
    fs.writeFileSync(path.join(ad,'quests.json'), JSON.stringify(state.tasks,null,2));
    save();
    return send(res,200,{ok:true,count:state.tasks.length,room:currentRoom});
  }
  if(p==='/api/room/asset'){
    const name=String(u.searchParams.get('name')||'quests').replace(/[^a-z0-9_-]/gi,'');
    const f=path.join(roomDir(currentRoom),'assets',name+'.html');
    if(!fs.existsSync(f)) return send(res,404,'not found','text/plain');
    return send(res,200,fs.readFileSync(f),'text/html; charset=utf-8');
  }
  if(p==='/api/generate/course' && req.method==='POST'){
    const b=await readBody(req);
    const title=String(b.title||'').slice(0,80)||'课程';
    const outline=String(b.outline||'').slice(0,8000);
    const courseware=String(b.courseware||'').slice(0,8000);
    if(!outline.trim()&&!courseware.trim()) return send(res,400,{ok:false,error:'请提供课程大纲或课件内容'});
    const mc=modelCfg(); if(!mc.key) return send(res,400,{ok:false,error:'请先在「模型管理」里配置模型与 API Key'});
    const base='课程名称：'+title+'\n大纲：\n'+outline+'\n课件/素材：\n'+courseware+'\n';
    const r1=await genText('你是企业 AI 培训课程设计助手。根据素材输出讲课大纲，只输出大纲本身，不要解释。格式：第一行“# 课程标题”，每个页用“## 页标题”，页下要点用“- ”开头。\n'+base,6000);
    const r2=await genText('根据素材输出宣传页文案，逐行输出，不要解释。格式：\n标题：一句话主标题\n副标题：一句话副标题\n介绍：80 字以内介绍\n模块：模块名\n- 该模块要点\n收益：一条学员收益（可多行）\n安排：09:00|开场与分组\n行动：报名或咨询\n'+base,4000);
    const r3=await genText('根据素材生成随堂题库，每行一条，用竖线分隔，不要解释。格式：\n选择|题目|选项A|选项B|选项C|选项D|正确答案字母\n判断|题目|对或错\n填空|题目|答案\n简答|题目|参考答案\n要求：选择 6 道、判断 4 道、填空 4 道、简答 2 道。\n'+base,2000);
    const r4=await genText('根据素材生成课程过程素材与作业场景题，每行一条，用竖线分隔，不要解释。格式：\n素材|标题|正文（可含要点，用；分隔）\n作业|标题|场景描述|要求1;要求2|交付物|验收标准\n要求：素材至少 4 条，作业 6 条。\n'+base,2000);
    const pk=newPackageDir(title); const id=pk.id, dir=pk.dir;
    const course=parseCourseText(cleanText(r1.text));
    const promo=parsePromoText(cleanText(r2.text));
    const quiz=normalizeQuiz(parseQuizText(cleanText(r3.text)));
    const misc=parseMiscText(cleanText(r4.text));
    const r5=await genText('根据素材生成 6 道作业场景题，每行一条，用竖线分隔，不要解释。格式：作业|标题|场景描述|要求1;要求2|交付物|验收标准\n'+base,4000);
    let hw=parseHomeworkText(r5.text);
    if(hw.length<6){ const r6=await genText('再补充 '+(6-hw.length)+' 道作业场景题，每行一条，用竖线分隔，不要编号、不要 markdown、不要解释。每行必须以 作业| 开头。格式：作业|标题|场景描述|要求1;要求2|交付物|验收标准\n'+base,6000); hw=hw.concat(parseHomeworkText(r6.text)); }
    if(hw.length<1){ const r7=await genText('只输出 6 行作业场景题，不要任何解释或标题。每行严格按格式：作业|标题|场景|要求1;要求2|交付物|验收标准'+String.fromCharCode(10)+'课程主题：'+title+String.fromCharCode(10)+'大纲：'+outline,6000); hw=hw.concat(parseHomeworkText(r7.text)); }
    fs.mkdirSync(path.join(dir,'raw'),{recursive:true});
    fs.writeFileSync(path.join(dir,'raw','course.txt'),String(r1.text||''));
    fs.writeFileSync(path.join(dir,'raw','promo.txt'),String(r2.text||''));
    fs.writeFileSync(path.join(dir,'raw','quiz.txt'),String(r3.text||''));
    fs.writeFileSync(path.join(dir,'raw','misc.txt'),String(r4.text||''));
    if(!course.sections||!course.sections.length) course.sections=[{type:'cover',title:title,text:outline.slice(0,120)}];
    fs.writeFileSync(path.join(dir,'index.html'), renderCoursePackage({title:course.title||title,subtitle:promo.subline||'',date:''}, course));
    fs.writeFileSync(path.join(dir,'promo.html'), renderPromo({title:title}, promo));
    fs.writeFileSync(path.join(dir,'course.json'), JSON.stringify(course,null,2));
    fs.writeFileSync(path.join(dir,'promo.json'), JSON.stringify(promo,null,2));
    fs.writeFileSync(path.join(dir,'materials.json'), JSON.stringify(misc.materials||[],null,2));
    fs.writeFileSync(path.join(dir,'quiz.json'), JSON.stringify(quiz,null,2));
    fs.writeFileSync(path.join(dir,'homework.json'), JSON.stringify(hw.length?hw:misc.homework,null,2));
    misc.materials.forEach(function(m,i){ const name=String(i+1).padStart(2,'0')+'-'+String(m.title||'素材').replace(/[\\/:*?"<>|]/g,'_')+'.md'; fs.writeFileSync(path.join(dir,'materials',name), '# '+(m.title||'素材')+'\n\n'+(m.content||'')); });
    fs.writeFileSync(path.join(dir,'meta.json'), JSON.stringify({id,title,createdAt:new Date().toISOString(),model:mc.model,quiz:{choice:quiz.choice.length,judge:quiz.judge.length,blank:quiz.blank.length,short:quiz.short.length},homework:(hw.length?hw.length:misc.homework.length),materials:misc.materials.length},null,1));
    return send(res,200,{ok:true,id,title,model:mc.model,urls:{course:'/pkg/'+id+'/index.html',promo:'/pkg/'+id+'/promo.html',quiz:'/pkg/'+id+'/quiz.json',homework:'/pkg/'+id+'/homework.json'},counts:{quiz:{choice:quiz.choice.length,judge:quiz.judge.length,blank:quiz.blank.length,short:quiz.short.length},homework:(hw.length?hw.length:misc.homework.length),materials:misc.materials.length},errors:[r1.err,r2.err,r3.err,r4.err,r5.err].filter(Boolean)});
  }
  if(p==='/api/generate/apply-quiz' && req.method==='POST'){
    const b=await readBody(req); const id=String(b.pkg||'');
    if(!/^pkg-[a-z0-9]+$/.test(id)) return send(res,400,{ok:false,error:'bad package'});
    let q={}; try{ q=JSON.parse(fs.readFileSync(path.join(PACKAGES_DIR,id,'quiz.json'),'utf8')); }catch(e){ return send(res,404,{ok:false,error:'no quiz'}); }
    state.quiz=state.quiz||{};
    state.quiz.bank=normalizeQuiz(q);
    state.quiz.config={mode:'random',counts:{choice:5,judge:3,blank:2,short:1},scores:{choice:2,judge:2,blank:3,short:10}};
    let _m={}; try{_m=JSON.parse(fs.readFileSync(roomMetaFile(currentRoom),'utf8'));}catch(e){} _m.packageId=id; fs.writeFileSync(roomMetaFile(currentRoom),JSON.stringify(_m,null,1));
    save();
    return send(res,200,{ok:true,counts:{choice:state.quiz.bank.choice.length,judge:state.quiz.bank.judge.length,blank:state.quiz.bank.blank.length,short:state.quiz.bank.short.length}});
  }
  if(p==='/api/package' && req.method==='GET'){
    const id=String(u.searchParams.get('pkg')||'');
    if(!/^pkg-[a-z0-9]+$/.test(id)) return send(res,400,{ok:false,error:'bad package'});
    const dir=path.join(PACKAGES_DIR,id);
    if(!fs.existsSync(dir)) return send(res,404,{ok:false,error:'not found'});
    const read=function(f,d){ try{ return JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')); }catch(e){ return d; } };
    return send(res,200,{ok:true,id,meta:read('meta.json',{}),course:read('course.json',null),promo:read('promo.json',null),quiz:read('quiz.json',{choice:[],judge:[],blank:[],short:[]}),homework:read('homework.json',[]),materials:read('materials.json',[]),urls:{course:'/pkg/'+id+'/index.html',promo:'/pkg/'+id+'/promo.html'}});
  }
  if(p==='/api/package/save' && req.method==='POST'){
    const b=await readBody(req); const id=String(b.pkg||''); const type=String(b.type||'');
    if(!/^pkg-[a-z0-9]+$/.test(id)) return send(res,400,{ok:false,error:'bad package'});
    const dir=path.join(PACKAGES_DIR,id); if(!fs.existsSync(dir)) return send(res,404,{ok:false,error:'not found'});
    let meta={}; try{ meta=JSON.parse(fs.readFileSync(path.join(dir,'meta.json'),'utf8')); }catch(e){}
    try{
      if(type==='course'){
        const d=b.data||{}; if(!Array.isArray(d.sections)) return send(res,400,{ok:false,error:'课程页需要 sections 数组'});
        fs.writeFileSync(path.join(dir,'course.json'), JSON.stringify(d,null,2));
        fs.writeFileSync(path.join(dir,'index.html'), renderCoursePackage({title:d.title||meta.title||'课程',subtitle:d.subtitle||'',date:d.date||''}, d));
      }else if(type==='promo'){
        const d=b.data||{}; fs.writeFileSync(path.join(dir,'promo.json'), JSON.stringify(d,null,2));
        fs.writeFileSync(path.join(dir,'promo.html'), renderPromo({title:meta.title||d.headline||'课程'}, d));
      }else if(type==='quiz'){
        const q=normalizeQuiz(b.data||{}); fs.writeFileSync(path.join(dir,'quiz.json'), JSON.stringify(q,null,2));
      }else if(type==='homework'){
        if(!Array.isArray(b.data)) return send(res,400,{ok:false,error:'作业需要数组'});
        fs.writeFileSync(path.join(dir,'homework.json'), JSON.stringify(b.data,null,2));
      }else if(type==='materials'){
        const arr=Array.isArray(b.data)?b.data:[];
        fs.writeFileSync(path.join(dir,'materials.json'), JSON.stringify(arr,null,2));
        const mdir=path.join(dir,'materials'); if(fs.existsSync(mdir)) fs.rmSync(mdir,{recursive:true,force:true});
        fs.mkdirSync(mdir,{recursive:true});
        arr.forEach(function(m,i){ const name=String(i+1).padStart(2,'0')+'-'+String(m.title||'素材').replace(/[\\/:*?"<>|]/g,'_')+'.md'; fs.writeFileSync(path.join(mdir,name), '# '+(m.title||'素材')+'\n\n'+(m.content||'')); });
      }else return send(res,400,{ok:false,error:'bad type'});
      meta.updatedAt=new Date().toISOString(); fs.writeFileSync(path.join(dir,'meta.json'), JSON.stringify(meta,null,1));
      return send(res,200,{ok:true,urls:{course:'/pkg/'+id+'/index.html',promo:'/pkg/'+id+'/promo.html'}});
    }catch(e){ return send(res,500,{ok:false,error:String(e.message||e)}); }
  }
  if(p==='/api/packages' && req.method==='GET') return send(res,200,{ok:true,packages:listPackages()});
  if(p==='/api/packages' && req.method==='POST'){
    const title=String(u.searchParams.get('title')||'课程包');
    const buf=await readRaw(req,20*1024*1024);
    if(!buf.length) return send(res,400,{ok:false,error:'空文件'});
    const id=savePackage(title, buf.toString('utf8'));
    return send(res,200,{ok:true,id,url:'/pkg/'+id+'/index.html'});
  }
  if(p==='/api/packages/delete' && req.method==='POST'){
    const b=await readBody(req); const id=String(b.id||'');
    if(!/^pkg-[a-z0-9]+$/.test(id)) return send(res,400,{ok:false,error:'bad id'});
    const dir=path.join(PACKAGES_DIR,id);
    if(fs.existsSync(dir)) fs.rmSync(dir,{recursive:true,force:true});
    return send(res,200,{ok:true});
  }
  if(p==='/api/packages/ai' && req.method==='POST'){
    const b=await readBody(req);
    const content=String(b.content||'').slice(0,6000);
    if(!content.trim()) return send(res,400,{ok:false,error:'缺少内容'});
    const prompt='你是课程设计助手。把下面素材整理成讲课大纲，只输出大纲，不要解释。\n格式：第一行以“# 课程标题”开头；之后每一页以“## 页标题”开头；每页要点用“- ”开头，每行一条。\n素材：\n'+content;
    const r=await modelChat([{role:'user',content:prompt}],2000);
    if(!r.ok) return send(res,502,{ok:false,error:r.error});
    const lines=String(r.content||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    let title='AI 课程包'; const sections=[]; let cur=null;
    lines.forEach(function(line){
      if(/^#\s+/.test(line)&&!/^##\s+/.test(line)){ title=line.replace(/^#\s+/,''); return; }
      if(/^##\s+/.test(line)){ if(cur)sections.push(cur); cur={type:'bullets',title:line.replace(/^##\s+/,''),items:[]}; return; }
      if(/^[-*]\s+/.test(line)){ (cur||(cur={type:'bullets',title:'要点',items:[]})).items.push(line.replace(/^[-*]\s+/,'')); return; }
      if(cur) cur.items.push(line);
    });
    if(cur) sections.push(cur);
    if(!sections.length){ const pages=String(content).split(/\n{2,}/).slice(0,12); pages.forEach(function(t,i){ sections.push({type:i===0?'cover':'bullets',title:i===0?'课程提要':('要点 '+(i+1)),text:i===0?t.slice(0,120):'',items:i===0?[]:t.split(/[。；;]/).filter(Boolean).slice(0,6)}) }); }
    sections.unshift({type:'cover',title:title,text:'',meta:''});
    const doc={title:title,subtitle:'',date:'',sections:sections};
    const html=renderCoursePackage({title:title}, doc);
    const id=savePackage(title, html);
    return send(res,200,{ok:true,id,url:'/pkg/'+id+'/index.html',title:title});
  }
  if(p.startsWith('/pkg/')){
    const rest=decodeURIComponent(p.slice('/pkg/'.length)).split('/');
    const id=rest.shift()||''; const rel=rest.join('/')||'index.html';
    if(!/^pkg-[a-z0-9]+$/.test(id)) return send(res,404,'not found','text/plain');
    const file=path.resolve(PACKAGES_DIR,id,rel);
    if(!file.startsWith(path.resolve(PACKAGES_DIR,id))||!fs.existsSync(file)) return send(res,404,'not found','text/plain');
    const ext=path.extname(file).slice(1).toLowerCase();
    const ct=ext==='html'?'text/html; charset=utf-8':ext==='css'?'text/css; charset=utf-8':ext==='js'?'text/javascript; charset=utf-8':ext==='svg'?'image/svg+xml':'application/octet-stream';
    return send(res,200,fs.readFileSync(file),ct);
  }
  if(AUTH_REQUIRED){
    const cookieTeacher=getCookieTeacher(req);
    const tokenTeacher=cookieTeacher?null:teacherByMcpToken(bearerToken(req));
    const teacher=cookieTeacher||tokenTeacher;
    let htmlGuarded=(p==='/ops'||p==='/admin'||p==='/grader'||p==='/shell'||p==='/teachers'||p==='/packages'||p==='/report'||p==='/remote'||p==='/package-edit'||p==='/room'||p==='/home'||p==='/room-setup');
    let apiGuarded=(p.indexOf('/api/admin')===0)||(p.indexOf('/api/teachers')===0)||(p.indexOf('/api/rooms')===0)||(p==='/api/report')||(p==='/api/report.csv')||(p.indexOf('/api/packages')===0)||(p.indexOf('/api/generate')===0)||(p.indexOf('/api/package')===0)||(p==='/api/extract')||(p==='/api/dingtalk/diag')||(p==='/api/dingtalk/debug')||(p==='/api/dingtalk/refresh')||(p==='/api/room/upload')||(p==='/api/room/markdown');
    if(p==='/report' && u.searchParams.get('embed')==='1') htmlGuarded=false;
    if(p==='/api/screen/perf'||p==='/api/screen/tab') apiGuarded=false;
    if(p==='/api/report' && u.searchParams.get('embed')==='1') apiGuarded=false;
    if(htmlGuarded&&!teacher){ res.writeHead(302,{Location:'/login'}); return res.end(); }
    if(apiGuarded&&!teacher) return send(res,401,{ok:false,error:'login required'});
    if(apiGuarded&&tokenTeacher&&tokenTeacher.role!=='admin'){ const _rq=u.searchParams.get('room'); if(_rq){ if(!canMcpRoom(tokenTeacher,currentRoom)) return send(res,403,{ok:false,error:'该 MCP 令牌无权访问这个场次'}); } else if(p.indexOf('/api/admin')===0||p==='/api/report'||p==='/api/report.csv'||p==='/api/room/upload'||p==='/api/room/markdown'){ return send(res,403,{ok:false,error:'使用 MCP 令牌调用后台接口时必须带 ?room=场次码'}); } }
  }
  if(p==='/api/rooms' && req.method==='GET') return send(res,200,{ok:true,rooms:listRooms(getTeacher(req)),current:currentRoom});
  if(p==='/api/rooms/create' && req.method==='POST'){
    const b=await readBody(req);
    const _t=getTeacher(req); const code=createRoom(b.title,b.city,b.date,_t&&_t.id,b.province,b.project);
    return send(res,200,{ok:true,code,urls:{room:'/room?code='+code,ops:'/ops?room='+code,join:'/join?room='+code,screen:'/screen?room='+code,remote:'/remote?room='+code}});
  }
  if(p==='/api/rooms/update' && req.method==='POST'){
    const b=await readBody(req); const code=String(b.code||'').toUpperCase();
    if(code===DEFAULT_ROOM) return send(res,400,{ok:false,error:'默认房间不可修改'});
    if(!validRoom(code)) return send(res,400,{ok:false,error:'房间码不对'});
    let meta={}; try{ meta=JSON.parse(fs.readFileSync(roomMetaFile(code),'utf8')); }catch(e){ return send(res,404,{ok:false,error:'房间不存在'}); }
    const oldCity=meta.city||''; const oldDate=meta.date||''; const oldProject=meta.project||'';
    const oldAutoCity=oldDate+' '+(oldCity||'未设城市');
    const oldAutoProject=oldDate+' '+(oldProject||'未命名客户/项目');
    const nextCity=b.city!==undefined?String(b.city||'').trim():oldCity;
    const nextProvince=b.province!==undefined?String(b.province||'').trim():(meta.province||'');
    const nextProject=b.project!==undefined?String(b.project||'').trim():oldProject;
    const nextDate=b.date!==undefined?String(b.date||'').trim():oldDate;
    const autoTitle=nextDate+' '+(nextProject||'未命名客户/项目');
    const currentAuto=(!meta.title||meta.title===oldAutoCity||meta.title===oldAutoProject);
    let nextTitle=meta.title||autoTitle;
    if(b.title!==undefined){
      const incoming=String(b.title||'').trim();
      if(!incoming) nextTitle=autoTitle;
      else if(incoming!==meta.title && incoming!==oldAutoCity && incoming!==oldAutoProject) nextTitle=incoming;
      else nextTitle=currentAuto?autoTitle:meta.title;
    }else if(currentAuto){ nextTitle=autoTitle; }
    meta.title=nextTitle; meta.city=nextCity; meta.date=nextDate; meta.province=nextProvince; meta.project=nextProject;
    fs.writeFileSync(roomMetaFile(code), JSON.stringify(meta,null,1));
    return send(res,200,{ok:true,meta});
  }
  if(p==='/api/rooms/delete' && req.method==='POST'){
    const b=await readBody(req); const code=String(b.code||'').toUpperCase();
    if(code===DEFAULT_ROOM) return send(res,400,{ok:false,error:'默认房间不可删除'});
    if(!validRoom(code)) return send(res,400,{ok:false,error:'房间码不对'});
    const dir=path.join(ROOMS_DIR,code);
    if(!fs.existsSync(dir)) return send(res,404,{ok:false,error:'房间不存在'});
    fs.rmSync(dir,{recursive:true,force:true});
    return send(res,200,{ok:true,code});
  }
  if(p==='/api/rooms/clear' && req.method==='POST'){
    const b=await readBody(req); const code=String(b.code||'').toUpperCase();
    if(!validRoom(code)) return send(res,400,{ok:false,error:'房间码不对'});
    const f=roomStateFile(code); if(!fs.existsSync(f)) return send(res,404,{ok:false,error:'房间不存在'});
    setRoom(code); state=roomCache[currentRoom]=blank(); save();
    return send(res,200,{ok:true,code});
  }
  if(p==='/api/screen/perf' && req.method==='POST'){
    const b=await readBody(req); const g=String(b.group||''); const d=Math.max(-10,Math.min(10,Number(b.delta)||0));
    if(!state.groups[g]) return send(res,400,{ok:false,error:'分组不存在'});
    state.groups[g].perf=(state.groups[g].perf||0)+d; state.updatedAt=new Date().toISOString(); save();
    return send(res,200,{ok:true,group:g,perf:state.groups[g].perf});
  }
  if(p==='/api/screen/tab' && req.method==='POST'){ const b=await readBody(req); const t=String(b.tab||''); if(['base','poll','groups','homework','quiz'].indexOf(t)<0) return send(res,400,{ok:false,error:'tab 不支持'}); state.config=state.config||{}; state.config.screenDataTab=t; state.config.screenView='data'; state.updatedAt=new Date().toISOString(); save(); return send(res,200,{ok:true,screenView:'data',screenDataTab:t}); }
  if(p==='/api/screen') return send(res,200,screenView());
  if(p==='/api/stream'){
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache','Connection':'keep-alive','Access-Control-Allow-Origin':'*'});
    res.write('retry: 3000\n\n');
    const tick=function(){ try{ res.write('data: '+JSON.stringify(screenView())+'\n\n'); }catch(e){} };
    tick(); const t=setInterval(tick,2000);
    req.on('close',function(){ clearInterval(t); try{res.end()}catch(e){} });
    return;
  }
  if(p.startsWith('/materials/')){
    const name=decodeURIComponent(p.slice('/materials/'.length));
    const fp=path.join(__dirname,'materials',name);
    if(!fs.existsSync(fp)) return send(res,404,'not found','text/plain');
    const buf=fs.readFileSync(fp);
    const ext=(name.split('.').pop()||'').toLowerCase();
    const ct=ext==='csv'?'text/csv; charset=utf-8':(ext==='md'?'text/markdown; charset=utf-8':'application/octet-stream');
    res.writeHead(200,{'Content-Type':ct,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(name),'Cache-Control':'no-store','Access-Control-Allow-Origin':'*'});
    return res.end(buf);
  }
  if(p.startsWith('/api/')){
    try{
      if(p==='/api/ping') return send(res,200,{ok:true,ts:Date.now()});
      if(p==='/api/state'){ const name=u.searchParams.get('name')||''; const tail=u.searchParams.get('tail')||''; if(!name||!tail) return send(res,400,{ok:false,error:'need name+tail'}); ensureStudent(name,tail); return send(res,200,studentView(keyOf(name,tail))); }
      if(p==='/api/admin/state') return send(res,200,adminView());
        if(p==='/api/report'){
          const students=Object.keys(state.students).map(k=>Object.assign({key:k},state.students[k]));
          const subs=Object.keys(state.submissions).map(k=>{const p2=k.split('||');const st=state.students[p2[0]]||{};const sub=state.submissions[k];return {name:st.name||p2[0],tail:st.tail||'',task:p2[1],total:(sub.score&&sub.score.total)||0,grade:(sub.score&&sub.score.grade)||'',source:(sub.score&&sub.score.source)||'',at:sub.at}});
          const byTask={}; subs.forEach(x=>{byTask[x.task]=(byTask[x.task]||0)+1});
          const quiz=state.quiz||{};
          const answers=Object.keys(quiz.answers||{}).map(k=>{const a=quiz.answers[k];return {key:k,score:a.score,total:a.total,at:a.at}});
          return send(res,200,{ok:true,room:currentRoom,generatedAt:new Date().toISOString(),students,groups:screenView().groups,poll:screenView().poll,quiz:{paper:screenView().quiz,answers},submissions:{count:subs.length,byTask,list:subs},timer:state.timer||null});
        }
        if(p==='/api/report.csv'){
          const lines=['姓名,尾号,小组,投票,抢答,作业数'];
          Object.keys(state.students).forEach(function(k){const st=state.students[k];const subs=Object.keys(state.submissions).filter(x=>x.indexOf(k+'||')===0).length;lines.push([st.name,st.tail,st.group||'',st.votes||0,st.buzzes||0,subs].join(','))});
          return send(res,200,lines.join('\n'),'text/csv; charset=utf-8');
        }
      if(req.method==='POST'){
        const b=(p==='/api/upload')?{}:await readBody(req);
        if(p==='/api/join'){ const s=ensureStudent(b.name,b.tail); return send(res,200,{ok:true,me:s}); }
        if(p==='/api/draw'){
          if(!groupsOn()) return send(res,400,{ok:false,error:'分组抽签已关闭，按个人计分'});
          const k=keyOf(b.name,b.tail); const s=ensureStudent(b.name,b.tail);
          if(s.group) return send(res,200,{ok:true,group:s.group,already:true});
          const counts=groupCounts(); const max=Number(state.config&&state.config.groupMax)||3;
          const ids=Object.keys(state.groups).filter(g=>counts[g]<max);
          if(!ids.length) return send(res,409,{ok:false,error:'所有分组已满'});
          const min=Math.min.apply(null,ids.map(g=>counts[g])); const cand=ids.filter(g=>counts[g]===min);
          const g=cand[Math.floor(Math.random()*cand.length)]; s.group=g; state.updatedAt=new Date().toISOString(); save();
          return send(res,200,{ok:true,group:g});
        }
        if(p==='/api/vote'){
          const k=keyOf(b.name,b.tail); ensureStudent(b.name,b.tail);
          if(!state.poll.active) return send(res,400,{ok:false,error:'no active poll'});
          if(state.poll.votes[k]!==undefined) return send(res,400,{ok:false,error:'already voted'});
          const idx=Number(b.choice); if(!(idx>=0&&idx<state.poll.options.length)) return send(res,400,{ok:false,error:'bad choice'});
          state.poll.votes[k]=idx; const _st=state.students[k]; if(_st)_st.votes=(_st.votes||0)+1; state.updatedAt=new Date().toISOString(); save(); return send(res,200,{ok:true});
        }
        if(p==='/api/quiz/submit'){
          const k=keyOf(b.name,b.tail); ensureStudent(b.name,b.tail);
          const pz=state.quiz&&state.quiz.paper;
          if(!pz||!pz.active) return send(res,400,{ok:false,error:'答题未开始'});
          if(state.quiz.answers[k]) return send(res,400,{ok:false,error:'已经提交过'});
          const ans=b.answers||{}; let score=0,total=0; const detail=[];
          for(const q of pz.questions){
            total+=q.score||0;
            let ratio=qGrade(q,ans[q.id]); let via='rule';
            if(q.type==='short'){ const m=await qModelGrade(q,ans[q.id]); if(m!==null){ ratio=m/100; via='model'; } }
            const s=Math.round(ratio*(q.score||0)*10)/10; score+=s;
            detail.push({id:q.id,type:q.type,score:s,ratio:ratio,via:via});
          }
          state.quiz.answers[k]={at:new Date().toLocaleString('zh-CN'),score:Math.round(score*10)/10,total:total,answers:ans,detail:detail};
          save();
          return send(res,200,{ok:true,score:Math.round(score*10)/10,total:total});
        }
        if(p==='/api/homework'){
          if(!taskAllowed(b.task)) return send(res,400,{ok:false,error:'该作业未启用'});
          const k=keyOf(b.name,b.tail); ensureStudent(b.name,b.tail);
          state.submissions[k+'||'+b.task]={text:b.text||'',fileName:b.fileName||'',q1:b.q1||'',q2:b.q2||'',q3:b.q3||'',at:new Date().toLocaleString('zh-CN'),manual:[],score:null};
          state.updatedAt=new Date().toISOString(); save(); return send(res,200,{ok:true});
        }
        if(p==='/api/upload'&&req.method==='POST'){
          const q=u.searchParams;const name=q.get('name')||'',tail=q.get('tail')||'',task=q.get('task')||'T1',fn=q.get('filename')||'file.bin',batch=String(q.get('batch')||'');
          const k=keyOf(name,tail);ensureStudent(name,tail);
          if(!taskAllowed(task)) return send(res,400,{ok:false,error:'该作业未启用'});
          const chunks=[];let size=0;
          for await (const ch of req){size+=ch.length;if(size>25*1024*1024){return send(res,413,{ok:false,error:'file too large (25MB)'})}chunks.push(ch)}
          const buf=Buffer.concat(chunks);
          const safe=String(fn).replace(/[^\w.\-\u4e00-\u9fa5]/g,'_').slice(0,80);
          const safeK=k.replace(/[^a-zA-Z0-9_.\-\u4e00-\u9fa5]/g,'_');const dir=path.join(DATA_DIR,'uploads',safeK);fs.mkdirSync(dir,{recursive:true});
          const fname=task+'-'+Date.now()+'-'+safe;fs.writeFileSync(path.join(dir,fname),buf);
          const key=k+'||'+task;
          let sub=state.submissions[key];
          /* 一次「确认提交」是一个 batch：同批多文件追加；再次提交整批覆盖，旧评分作废。 */
          if(!sub||(batch&&sub.batch!==batch)) sub={text:'',q1:'',q2:'',q3:'',at:new Date().toLocaleString('zh-CN'),manual:[],score:null,files:[],batch:batch||''};
          sub.batch=batch||sub.batch||'';
          sub.files=sub.files||[];sub.files.push({name:fn,size:buf.length,path:fname,at:new Date().toLocaleString('zh-CN')});
          if(/\.(md|txt)$/i.test(fn)&&!sub.text)sub.text=buf.toString('utf8').slice(0,6000);
          if(/\.(html?|docx|pptx|pdf|xlsx)$/i.test(fn)){ try{ const _txt=extractText(fn,buf).trim(); if(_txt)sub.text=_txt.slice(0,8000); }catch(e){} }
          /* 考试结果 JSON：解析评分存 sub.jsonScore（解读存档）；无 AI 评分时用它填 sub.score 让前端直接显示 */
          if(/\.json$/i.test(fn)){ try{ const _je=parseExamJson(buf.toString('utf8')); if(_je){ sub.jsonScore=_je; if(_je.total!==null) sub.score={source:'json',ai:false,total:_je.total,override:_je.total,items:_je.items,grade:_je.grade,at:_je.at}; } }catch(e){} }
          sub.at=new Date().toLocaleString('zh-CN');
          state.submissions[key]=sub;state.updatedAt=new Date().toISOString();save();
          return send(res,200,{ok:true,files:sub.files,batch:sub.batch});
        }
        if(p==='/api/file'){const k=u.searchParams.get('key')||'',task=u.searchParams.get('task')||'',idx=Number(u.searchParams.get('i')||0);
          const sub=state.submissions[k+'||'+task];if(!sub||!sub.files||!sub.files[idx])return send(res,404,'not found','text/plain');
          const safeK2=k.replace(/[^a-zA-Z0-9_.\-\u4e00-\u9fa5]/g,'_');const fp=path.join(DATA_DIR,'uploads',safeK2,sub.files[idx].path);
          return fs.readFile(fp,(e,b)=>e?send(res,404,'not found','text/plain'):send(res,200,b,'application/octet-stream'));
        }
        if(p==='/api/admin/quizbank'){
          state.quiz=state.quiz||{bank:{choice:[],judge:[],blank:[],short:[]}};
          state.quiz.bank=state.quiz.bank||{choice:[],judge:[],blank:[],short:[]};
          const mode=b.action==='append'?'append':'replace';
          const incoming=b.bank||{};
          if(mode==='replace') state.quiz.bank={choice:[],judge:[],blank:[],short:[]};
          ['choice','judge','blank','short'].forEach(function(t){
            (incoming[t]||[]).forEach(function(q,i){ const item=Object.assign({},q); item.type=t; item.id=t+'-'+Date.now()+'-'+i; state.quiz.bank[t].push(item); });
          });
          state.updatedAt=new Date().toISOString();save();
          return send(res,200,{ok:true,counts:{choice:state.quiz.bank.choice.length,judge:state.quiz.bank.judge.length,blank:state.quiz.bank.blank.length,short:state.quiz.bank.short.length}});
        }
        if(p==='/api/admin/quizgen' && req.method==='POST'){
          const source=String(b.source||'').trim().slice(0,12000);
          if(!source) return send(res,400,{ok:false,error:'请先粘贴课程大纲或素材'});
          const mc=modelCfg(); if(!mc.key) return send(res,400,{ok:false,error:'请先在「模型管理」配置 API Key'});
          const prompt='你是企业 AI 培训的出题助手。根据下面的课程内容生成随堂题库，每行一条，用竖线分隔，不要解释、不要编号、不要 markdown。\n格式：\n选择|题目|选项A|选项B|选项C|选项D|正确答案字母\n判断|题目|对或错\n填空|题目|答案\n简答|题目|参考答案\n要求：选择 8 道、判断 4 道、填空 2 道、简答 1 道；题目要贴合课程内容，避免重复。\n\n课程内容：\n'+source;
          const r=await genText(prompt,6000);
          if(r.err) return send(res,502,{ok:false,error:r.err});
          const gen=normalizeQuiz(parseQuizText(cleanText(r.text)));
          const added={choice:gen.choice.length,judge:gen.judge.length,blank:gen.blank.length,short:gen.short.length};
          const total=added.choice+added.judge+added.blank+added.short;
          if(!total) return send(res,502,{ok:false,error:'模型返回无法解析：'+(r.text||'').slice(0,180)});
          state.quiz=state.quiz||{bank:{choice:[],judge:[],blank:[],short:[]},answers:{}};
          state.quiz.bank=Object.assign({choice:[],judge:[],blank:[],short:[]},state.quiz.bank||{});
          const stamp=Date.now().toString(36);
          ['choice','judge','blank','short'].forEach(function(t){
            gen[t].forEach(function(q,i){ q.id=t+'-gen-'+stamp+'-'+i; state.quiz.bank[t].push(q); });
          });
          state.updatedAt=new Date().toISOString();save();
          return send(res,200,{ok:true,added:added,counts:{choice:state.quiz.bank.choice.length,judge:state.quiz.bank.judge.length,blank:state.quiz.bank.blank.length,short:state.quiz.bank.short.length}});
        }
        if(p==='/api/admin/quiz'){
          state.quiz=state.quiz||{bank:{choice:[],judge:[],blank:[],short:[]},answers:{}};
          if(b.action==='publish'){
            const cfg={mode:b.mode==='seq'?'seq':'random',counts:b.counts||{},scores:b.scores||{}};
            const qs=quizBuildPaper(cfg);
            if(!qs.length) return send(res,400,{ok:false,error:'题库为空或各类数量为 0'});
            state.quiz.config=cfg;
            state.quiz.paper={active:true,at:new Date().toLocaleString('zh-CN'),mode:cfg.mode,counts:cfg.counts,scores:cfg.scores,questions:qs};
            state.quiz.answers={}; state.quiz.papers={};
            if(cfg.mode==='random'){ Object.keys(state.students||{}).forEach(function(k){ state.quiz.papers[k]=quizBuildPaper(cfg); }); }
            save();
            return send(res,200,{ok:true,count:qs.length,points:qs.reduce(function(a,q){return a+(q.score||0)},0),mode:cfg.mode});
          }
          if(b.action==='startPreset'){
            const cfg=state.quiz.config||{mode:'random',counts:{choice:5,judge:3,blank:2,short:1},scores:{choice:2,judge:2,blank:3,short:10}};
            const qs=quizBuildPaper(cfg);
            if(!qs.length) return send(res,400,{ok:false,error:'题库为空'});
            state.quiz.paper={active:true,at:new Date().toLocaleString('zh-CN'),mode:cfg.mode,counts:cfg.counts,scores:cfg.scores,questions:qs};
            state.quiz.answers={}; state.quiz.papers={};
            if(cfg.mode==='random'){ Object.keys(state.students||{}).forEach(function(k){ state.quiz.papers[k]=quizBuildPaper(cfg); }); }
            save(); return send(res,200,{ok:true,count:qs.length,mode:cfg.mode});
          }
          if(b.action==='close'){ if(state.quiz.paper) state.quiz.paper.active=false; save(); return send(res,200,{ok:true}); }
          if(b.action==='clear'){ state.quiz.paper=null; state.quiz.answers={}; save(); return send(res,200,{ok:true}); }
          if(b.action==='resetbank'){ state.quiz.bank={choice:[],judge:[],blank:[],short:[]}; state.quiz.paper=null; state.quiz.answers={}; save(); return send(res,200,{ok:true}); }
          return send(res,400,{ok:false,error:'bad action'});
        }
        if(p==='/api/admin/groupcfg'){ state.config=state.config||{};
            if(b.enabled!==undefined){ state.config.groupsEnabled=!!b.enabled; }
            if(b.max!==undefined){ state.config.groupMax=Math.max(1,Math.min(10,Number(b.max)||3)); }
            save(); return send(res,200,{ok:true,groupMax:state.config.groupMax||3,groupsEnabled:groupsOn()}); }
        if(p==='/api/admin/groupadd'){ if(!groupsOn()) return send(res,400,{ok:false,error:'分组抽签已关闭'});
          const used=Object.keys(state.groups);
          const letter='ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter(c=>used.indexOf(c)<0)[0];
          if(!letter) return send(res,400,{ok:false,error:'分组已达上限'});
          state.groups[letter]={name:letter+'组',perf:0}; state.updatedAt=new Date().toISOString(); save();
          return send(res,200,{ok:true,id:letter});
        }
        if(p==='/api/admin/grouprename'){ if(!groupsOn()) return send(res,400,{ok:false,error:'分组抽签已关闭'});
          if(!state.groups[b.id]) return send(res,404,{ok:false,error:'no group'});
          state.groups[b.id].name=String(b.name||'').trim()||state.groups[b.id].name; save();
          return send(res,200,{ok:true});
        }
        if(p==='/api/admin/groupdel'){ if(!groupsOn()) return send(res,400,{ok:false,error:'分组抽签已关闭'});
          const ids=Object.keys(state.groups);
          if(ids.length<=1) return send(res,400,{ok:false,error:'至少保留一个分组'});
          if(!state.groups[b.id]) return send(res,404,{ok:false,error:'no group'});
          delete state.groups[b.id];
          Object.keys(state.students).forEach(k=>{ if(state.students[k].group===b.id) state.students[k].group='' });
          save(); return send(res,200,{ok:true});
        }
        if(p==='/api/admin/student'){
          const act=b.action;
          if(act==='clear'){
            state.students={};state.submissions={};state.poll.votes={};state.buzz={enabled:false,running:false,winner:'',winnerKey:'',round:0,at:'',counts:{}};state.roll={active:false,key:'',name:'',round:0,at:0};
            state.updatedAt=new Date().toISOString();save();return send(res,200,{ok:true});
          }
          const oldKey=b.key, st=state.students[oldKey];
          if(!st) return send(res,404,{ok:false,error:'student not found'});
          if(act==='delete'){
            Object.keys(state.submissions).forEach(k=>{ if(k.indexOf(oldKey+'||')===0) delete state.submissions[k] });
            if(state.poll.votes) delete state.poll.votes[oldKey];
            delete state.students[oldKey]; save(); return send(res,200,{ok:true});
          }
          if(act==='update'){
            const nn=(b.name||st.name).trim(), nt=(b.tail||st.tail).trim(), ng=(b.group!==undefined?b.group:st.group);
            const nk=keyOf(nn,nt);
            delete state.students[oldKey];
            state.students[nk]=Object.assign({},st,{name:nn,tail:nt,group:ng});
            if(nk!==oldKey){
              Object.keys(state.submissions).forEach(k=>{ if(k.indexOf(oldKey+'||')===0){ state.submissions[nk+k.slice(oldKey.length)]=state.submissions[k]; delete state.submissions[k]; } });
              if(state.poll.votes&&state.poll.votes[oldKey]!==undefined){ state.poll.votes[nk]=state.poll.votes[oldKey]; delete state.poll.votes[oldKey]; }
            }
            save(); return send(res,200,{ok:true,key:nk});
          }
          return send(res,400,{ok:false,error:'bad action'});
        }
        if(p==='/api/admin/buzz'){
          state.buzz=state.buzz||{enabled:false,running:false,winner:'',at:''};
          const a=b.action;
          if(a==='enable'){state.buzz.enabled=true;state.buzz.running=false;state.buzz.winner='';state.buzz.winnerKey=''}
          else if(a==='disable'){state.buzz.enabled=false;state.buzz.running=false}
          else if(a==='start'){state.buzz.enabled=true;state.buzz.running=true;state.buzz.winner='';state.buzz.winnerKey='';state.buzz.round=(state.buzz.round||0)+1;state.buzz.at=new Date().toLocaleString('zh-CN')}
          else if(a==='reset'){state.buzz.running=false;state.buzz.winner='';state.buzz.winnerKey=''}
          state.updatedAt=new Date().toISOString();save();
          return send(res,200,{ok:true,buzz:state.buzz});
        }
        if(p==='/api/buzz'){
          const s=ensureStudent(b.name,b.tail);
          const _bk=keyOf(b.name,b.tail);
          state.buzz=state.buzz||{};
          if(!state.buzz.enabled) return send(res,400,{ok:false,error:'not enabled'});
          const _rq=Number(b.round||0);
          if(_rq && Number(state.buzz.round||0)!==_rq) return send(res,409,{ok:false,error:'round changed',round:state.buzz.round||0,winner:state.buzz.winner||''});
          if(state.buzz.winner) return send(res,200,{ok:true,winner:state.buzz.winner,winnerKey:state.buzz.winnerKey||'',won:state.buzz.winnerKey===_bk});
          if(!state.buzz.running) return send(res,400,{ok:false,error:'not running'});
          state.buzz.winner=s.name;state.buzz.winnerKey=_bk;state.buzz.running=false;s.buzzes=(s.buzzes||0)+1;state.updatedAt=new Date().toISOString();save();
          return send(res,200,{ok:true,winner:state.buzz.winner,winnerKey:state.buzz.winnerKey,won:true});
        }
        if(p==='/api/admin/votepreset'){
          state.votePresets=state.votePresets||[];
          if(b.action==='delete'){ state.votePresets=state.votePresets.filter(function(x){return x.id!==b.id}); save(); return send(res,200,{ok:true,list:state.votePresets}); }
          if(b.action==='add'){ const q=String(b.question||'').trim(); const opts=(b.options||[]).map(String).filter(Boolean); if(!q||opts.length<2) return send(res,400,{ok:false,error:'问题+至少两个选项'}); state.votePresets.push({id:'v-'+Date.now().toString(36),question:q,options:opts}); save(); return send(res,200,{ok:true,list:state.votePresets}); }
          if(b.action==='update'){ const v=state.votePresets.filter(function(x){return x.id===b.id})[0]; if(!v) return send(res,404,{ok:false,error:'题目不存在'}); if(b.question!==undefined){ const q=String(b.question||'').trim(); if(q)v.question=q; } if(Array.isArray(b.options)){ const opts=b.options.map(String).filter(Boolean); if(opts.length>=2)v.options=opts; } save(); return send(res,200,{ok:true,list:state.votePresets}); }
          return send(res,200,{ok:true,list:state.votePresets});
        }
        if(p==='/api/admin/cards'){
          state.cards=state.cards||[];
          if(b.action==='add'){ var c={id:'c-'+Date.now().toString(36),theme:String(b.theme||'').trim(),type:String(b.type||'行动卡'),content:String(b.content||'').trim(),attrs:String(b.attrs||'').trim()}; if(!c.theme) return send(res,400,{ok:false,error:'主题必填'}); state.cards.push(c); save(); return send(res,200,{ok:true,list:state.cards}); }
          if(b.action==='update'){ var cardU=state.cards.filter(function(x){return x.id===b.id})[0]; if(!cardU) return send(res,404,{ok:false,error:'卡片不存在'}); ['theme','type','content','attrs'].forEach(function(k){ if(b[k]!==undefined)cardU[k]=String(b[k]||'').trim(); }); save(); return send(res,200,{ok:true,list:state.cards}); }
          if(b.action==='delete'){ state.cards=state.cards.filter(function(x){return x.id!==b.id}); if(state.config&&state.config.activeCard===b.id)state.config.activeCard=''; save(); return send(res,200,{ok:true,list:state.cards}); }
          if(b.action==='push'){ var c2=state.cards.filter(function(x){return x.id===b.id})[0]; if(!c2) return send(res,404,{ok:false,error:'卡片不存在'}); state.config=state.config||{}; state.config.activeCard=b.id; state.config.workshopOpen=true; save(); return send(res,200,{ok:true,activeCard:b.id}); }
          if(b.action==='withdraw'){ state.config=state.config||{}; state.config.activeCard=''; state.config.workshopOpen=false; save(); return send(res,200,{ok:true}); }
          return send(res,200,{ok:true,list:state.cards});
        }
        if(p==='/api/admin/material'){ state.config=state.config||{}; state.config.materialOpen=!!b.open; save(); return send(res,200,{ok:true,materialOpen:state.config.materialOpen}); }
        if(p==='/api/admin/material-release'){
          const stored=(Array.isArray(b.stored)?b.stored:[b.stored]).map(String).filter(Boolean);
          if(!stored.length) return send(res,400,{ok:false,error:'先选择素材'});
          let meta={}; try{ meta=JSON.parse(fs.readFileSync(roomMetaFile(currentRoom),'utf8')); }catch(e){}
          const files=meta.files||[]; let matched=0; const released=!!b.released;
          const batch=released?((Number(state.config&&state.config.materialBatch)||0)+1):0;
          files.forEach(function(f){ if(stored.indexOf(f.stored)<0)return; matched++; f.released=released; f.releasedAt=released?new Date().toISOString():''; f.batch=released?batch:(f.batch||0); });
          if(!matched) return send(res,404,{ok:false,error:'没有匹配的素材'});
          meta.files=files; fs.writeFileSync(roomMetaFile(currentRoom),JSON.stringify(meta,null,1));
          clearRoomMetaCache(currentRoom);
          state.config=state.config||{}; if(released){ state.config.materialOpen=true; state.config.materialBatch=batch; }
          state.updatedAt=new Date().toISOString(); save();
          return send(res,200,{ok:true,count:matched,batch:batch,materialOpen:!!state.config.materialOpen});
        }
        if(p==='/api/admin/screen'){ state.config=state.config||{}; let v=(b.view==='course'||b.view==='workshop'||b.view==='data')?b.view:'data'; if(b.view==='poll'||b.view==='report'||b.view==='stats')v='data'; if(v==='data'){ var tabs=['base','poll','groups','homework','quiz']; var t=String(b.tab||state.config.screenDataTab||'base'); if(b.view==='poll')t='poll'; if(tabs.indexOf(t)>=0)state.config.screenDataTab=t; } state.config.screenView=v; save(); return send(res,200,{ok:true,screenView:v,screenDataTab:state.config.screenDataTab||'base'}); }
        if(p==='/api/admin/slide'){
          state.config=state.config||{}; let n=Number(state.config.slide)||0;
          if(b.action==='next')n++; else if(b.action==='prev')n=Math.max(0,n-1); else if(b.value!==undefined)n=Math.max(0,Number(b.value)||0);
          state.config.slide=n; save(); return send(res,200,{ok:true,slide:n});
        }
        if(p==='/api/admin/timer'){
          state.timer=state.timer||{running:false,endAt:0,duration:0};
          if(b.action==='start'){ const min=Math.max(1,Math.min(240,Number(b.minutes)||90)); state.timer={running:true,endAt:Date.now()+min*60000,duration:min*60000}; }
          else if(b.action==='pause'){ state.timer.running=false; state.timer.endAt=0; }
          else if(b.action==='reset'){ state.timer={running:false,endAt:0,duration:0}; }
          save(); return send(res,200,{ok:true,timer:state.timer});
        }
        if(p==='/api/admin/roll'){
          state.roll=state.roll||{active:false,key:'',name:'',round:0,at:0};
          if(b.action==='start'){
            var keys=Object.keys(state.students||{}); if(!keys.length) return send(res,400,{ok:false,error:'还没有学员，先让学员扫码进入'});
            var k=keys[Math.floor(Math.random()*keys.length)]; var st=state.students[k];
            state.roll={active:true,key:k,name:(st&&st.name)||'学员',round:(state.roll.round||0)+1,at:Date.now()};
            save(); return send(res,200,{ok:true,roll:state.roll});
          }
          if(b.action==='stop'){ state.roll.active=false; save(); return send(res,200,{ok:true,roll:state.roll}); }
          return send(res,200,{ok:true,roll:state.roll});
        }
        if(p==='/api/admin/workshopcfg'){ state.config=state.config||{}; state.config.wsMinutes=Math.max(1,Math.min(240,Number(b.minutes)||90)); save(); return send(res,200,{ok:true,wsMinutes:state.config.wsMinutes}); }
        if(p==='/api/admin/workshop'){ state.config=state.config||{}; state.config.workshopOpen=!!b.open; if(!b.open) state.config.activeCard=''; state.updatedAt=new Date().toISOString(); save(); return send(res,200,{ok:true,workshopOpen:state.config.workshopOpen}); }
        if(p==='/api/admin/hwcfg'){ state.config=state.config||{}; state.config.hwCount=Math.max(1,Math.min(6,Number(b.count)||6)); state.updatedAt=new Date().toISOString(); save(); return send(res,200,{ok:true,hwCount:hwCountOn()}); }
        if(p==='/api/admin/review'){ state.config=state.config||{}; state.config.reviewEnabled=!!b.open; state.updatedAt=new Date().toISOString(); save(); return send(res,200,{ok:true,reviewEnabled:reviewOn()}); }
        if(p==='/api/admin/hw'){ state.config=state.config||{hwOpen:false}; state.config.hwOpen=!!b.open; state.updatedAt=new Date().toISOString(); save(); return send(res,200,{ok:true,hwOpen:state.config.hwOpen}); }
        if(p==='/api/admin/delsub'){
          var sub=state.submissions[b.key];
          if(sub&&(sub.files||[]).length){ var safeK=String(b.key.split('||')[0]).replace(/[^a-zA-Z0-9_.\-\u4e00-\u9fa5]/g,'_');
            (sub.files||[]).forEach(function(f){ try{ fs.unlinkSync(path.join(DATA_DIR,'uploads',safeK,f.path)) }catch(e){} }); }
          delete state.submissions[b.key]; state.updatedAt=new Date().toISOString(); save(); return send(res,200,{ok:true});
        }
        if(p==='/api/admin/poll'){
          if(b.action==='stop'){ state.poll.active=false; save(); return send(res,200,{ok:true}); }
          state.poll={active:true,question:b.question||'',options:(b.options||[]).filter(x=>String(x).trim()),votes:{},startedAt:new Date().toLocaleString('zh-CN')};
          state.updatedAt=new Date().toISOString(); save(); return send(res,200,{ok:true});
        }
        if(p==='/api/admin/group'){ if(!groupsOn()) return send(res,400,{ok:false,error:'分组抽签已关闭'}); const k=keyOf(b.name,b.tail); const s=state.students[k]; if(!s) return send(res,404,{ok:false,error:'student not found'}); s.group=b.group||''; state.updatedAt=new Date().toISOString(); save(); return send(res,200,{ok:true}); }
        if(p==='/api/admin/perf'){ if(!groupsOn()) return send(res,400,{ok:false,error:'分组抽签已关闭'}); if(!state.groups[b.group]) return send(res,400,{ok:false,error:'bad group'}); state.groups[b.group].perf=(state.groups[b.group].perf||0)+Number(b.delta||0); state.updatedAt=new Date().toISOString(); save(); return send(res,200,{ok:true,perf:state.groups[b.group].perf}); }
        if(p==='/api/admin/model'){
          const act=b.action||'save';
          if(act==='test'){
            const cfg={baseUrl:(b.baseUrl||'').trim(),model:(b.model||'').trim(),apiKey:(b.apiKey||'').trim()||(state.config.model&&state.config.model.apiKey)||process.env.DEEPSEEK_API_KEY||''};
            if(!cfg.apiKey) return send(res,400,{ok:false,error:'请先填写 API Key'});
            const old=state.config.model; state.config.model=cfg;
            const r=await modelChat([{role:'user',content:'只回复两个字母：OK'}],20);
            state.config.model=old;
            if(!r.ok) return send(res,502,{ok:false,error:r.error});
            return send(res,200,{ok:true,reply:String(r.content).slice(0,40),ms:r.ms,model:r.model});
          }
          state.config.model=state.config.model||{};
          if(b.baseUrl!==undefined) state.config.model.baseUrl=String(b.baseUrl||'').trim();
          if(b.model!==undefined) state.config.model.model=String(b.model||'').trim();
          if(b.apiKey) state.config.model.apiKey=String(b.apiKey).trim();
          save(); return send(res,200,{ok:true});
        }
        if(p==='/api/admin/scoreai'){
          if(!reviewOn()) return send(res,400,{ok:false,error:'作业评审已关闭'});
          const mc=modelCfg(); if(!mc.key) return send(res,400,{ok:false,error:'请先在「模型管理」配置 API Key'});
          const sub=state.submissions[b.key]; if(!sub) return send(res,404,{ok:false,error:'submission not found'});
          const rr=await aiScoreSubmission(sub,b.rubric||[],b.task||'');
          if(!rr.ok) return send(res,502,{ok:false,error:rr.error});
          save(); return send(res,200,{ok:true,score:rr.score});
        }
        if(p==='/api/admin/rescore'){
          if(!reviewOn()) return send(res,400,{ok:false,error:'作业评审已关闭'});
          const mc=modelCfg(); if(!mc.key) return send(res,400,{ok:false,error:'请先在「模型管理」配置 API Key'});
          const items=Array.isArray(b.items)?b.items:[];
          if(!items.length) return send(res,400,{ok:false,error:'没有可重评的提交'});
          let scored=0; const failed=[];
          const queue=items.slice(0,8);
          for(const it of queue){
            const sub=state.submissions[it.key];
            const rr=await aiScoreSubmission(sub,it.rubric||[],it.task||'');
            if(rr.ok) scored++; else failed.push({key:it.key,task:it.task||'',error:rr.error||'failed'});
          }
          state.updatedAt=new Date().toISOString();save();
          return send(res,200,{ok:true,scored:scored,failed:failed,remaining:Math.max(0,items.length-queue.length)});
        }
        if(p==='/api/admin/score'){ if(!reviewOn()) return send(res,400,{ok:false,error:'作业评审已关闭'}); const sub=state.submissions[b.key]; if(!sub) return send(res,404,{ok:false,error:'submission not found'}); if(b.manual) sub.manual=b.manual; if(b.score) sub.score=b.score; save(); return send(res,200,{ok:true}); }
        /* score 可含 override 字段：人工直接定总分 */
        if(p==='/api/admin/reset'){ if(b.scope==='poll'){ state.poll={active:false,question:'',options:[],votes:{},startedAt:''}; } else if(b.scope==='groups'){ Object.values(state.students).forEach(s=>s.group=''); } else { const _m=state.config&&state.config.model; state=blank(); if(_m)state.config.model=_m; } save(); return send(res,200,{ok:true}); }
      }
      return send(res,404,{ok:false,error:'no api'});
    }catch(e){ return send(res,500,{ok:false,error:String(e.message||e)}); }
  }
  if(p==='/'){
    const t=getTeacher(req);
    if(t){ res.writeHead(302,{Location:'/home'}); return res.end(); }
    return send(res,200,fs.readFileSync(path.join(ROOT,'login.html')),'text/html; charset=utf-8');
  }
  serveStatic(res,p);
});
function lanIPs(){ const out=[]; const nets=os.networkInterfaces(); for(const n of Object.keys(nets)){ for(const a of nets[n]||[]){ if(a.family==='IPv4'&&!a.internal) out.push(a.address); } } return out; }
server.listen(PORT,'0.0.0.0',4096,()=>{ console.log('camp server on http://0.0.0.0:'+PORT); console.log('LAN: '+lanIPs().map(ip=>'http://'+ip+':'+PORT).join('  ')); console.log('ROOT='+ROOT); });
