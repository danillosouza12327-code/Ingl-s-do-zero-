// Inglês do Zero — servidor sem dependências (Node >= 22.13). Banco: SQLite em data/app.db
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {DatabaseSync}=require('node:sqlite');
const D=process.env.DATA_DIR||path.join(__dirname,'data');fs.mkdirSync(D,{recursive:true});
const PORT=process.env.PORT||3000,GK=(process.env.GEMINI_API_KEY||'').trim(),GMODELS=(process.env.GEMINI_MODEL?[process.env.GEMINI_MODEL.trim()]:[]).concat(['gemini-3.5-flash-lite','gemini-3.1-flash-lite','gemini-3.6-flash']),GBASE=(process.env.GEMINI_API_BASE||'https://generativelanguage.googleapis.com').replace(/\/$/,''),FREE=3;
const LESSONS=JSON.parse(fs.readFileSync(path.join(__dirname,'lessons.json')));
let SECRET=process.env.SECRET;if(!SECRET){const f=path.join(D,'secret');if(!fs.existsSync(f))fs.writeFileSync(f,crypto.randomBytes(32).toString('hex'),{mode:0o600});SECRET=fs.readFileSync(f,'utf8')}
const db=new DatabaseSync(path.join(D,'app.db'));
db.exec(`CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,n TEXT,w TEXT,e TEXT UNIQUE,pw TEXT,plan TEXT DEFAULT 'gratis',ini TEXT,exp TEXT DEFAULT '2099-12-31',st TEXT DEFAULT 'ativo',adm INTEGER DEFAULT 0,xp INTEGER DEFAULT 0,lvl TEXT DEFAULT '',done TEXT DEFAULT '[]',rev TEXT DEFAULT '[]',days TEXT DEFAULT '[]')`);
try{db.exec("ALTER TABLE users ADD COLUMN prog TEXT DEFAULT '{}'")}catch(e){}
const td=(o=0)=>new Date(Date.now()+o*864e5).toISOString().slice(0,10);
const hash=p=>{const s=crypto.randomBytes(16).toString('hex');return s+':'+crypto.scryptSync(p,s,32).toString('hex')};
const check=(p,h)=>{const[s,x]=h.split(':');return crypto.timingSafeEqual(Buffer.from(x,'hex'),crypto.scryptSync(p,s,32))};
const sign=(id,k='a',ms=30*864e5)=>{const b=Buffer.from(JSON.stringify({id,k,x:Date.now()+ms})).toString('base64url');return b+'.'+crypto.createHmac('sha256',SECRET).update(b).digest('base64url')};
const verify=(t,k='a')=>{try{const[b,s]=t.split('.');if(s!==crypto.createHmac('sha256',SECRET).update(b).digest('base64url'))return null;const o=JSON.parse(Buffer.from(b,'base64url'));return o.x>Date.now()&&o.k===k?o.id:null}catch{return null}};
const pub=u=>{if(!u)return null;const{pw,...r}=u;for(const k of['done','rev','days'])r[k]=JSON.parse(r[k]);try{r.prog=JSON.parse(r.prog||'{}')}catch{r.prog={}}return r};
const access=u=>u.plan==='premium'&&u.st==='ativo'&&u.exp>=td();
const byId=id=>db.prepare('SELECT * FROM users WHERE id=?').get(id),byE=e=>db.prepare('SELECT * FROM users WHERE e=?').get(e);
const mk=(n,w,e,p,plan,exp,adm=0)=>db.prepare('INSERT INTO users(n,w,e,pw,plan,ini,exp,adm) VALUES(?,?,?,?,?,?,?,?)').run(n,w||'',e,hash(p),plan,td(),exp||'2099-12-31',adm);
if(!db.prepare('SELECT 1 FROM users WHERE adm=1').get()){const e=process.env.ADMIN_EMAIL||'admin@ingleszero.com',p=process.env.ADMIN_PASSWORD||crypto.randomBytes(6).toString('hex');mk('Administrador','',e,p,'premium',null,1);console.log(`ADMIN criado: ${e} / ${p}  (anote e troque)`)}

// ===== Trilha com Professor (conteúdo em courses.json) =====
const LV=JSON.parse(fs.readFileSync(path.join(__dirname,'courses.json'),'utf8')),MODS=[],LES={},MT={};
LV.forEach(l=>l.mods.forEach(m=>{MODS.push(m);(m.lessons||[]).forEach(x=>LES[x.id]=m);const pool=(m.lessons||[]).flatMap(x=>x.vocab);
 if(pool.length>=3){MT[m.id]=pool.filter((_,i)=>i%2==0).slice(0,6).map((v,i)=>{const at=pool.indexOf(v),o=[v[0],pool[(at+1)%pool.length][0],pool[(at+2)%pool.length][0]],k=i%3,ops=o.slice(k).concat(o.slice(0,k));return{q:`Como se diz "${v[1]}" em inglês?`,ops,a:ops.indexOf(v[0])}})}}));
const getP=u=>{try{return JSON.parse(u.prog||'{}')}catch{return{}}},setP=(u,p)=>db.prepare('UPDATE users SET prog=? WHERE id=?').run(JSON.stringify(p),u.id);
const midx=id=>MODS.findIndex(m=>m.id===id),modOK=(u,m)=>{const i=midx(m.id);return i===0||((getP(u).mods||{})[MODS[i-1].id]||0)>=70},canMod=(u,m)=>modOK(u,m)&&(midx(m.id)===0||access(u));
const fails=new Map(),aiUse=new Map(),SYSAI="Você é o Professor Alex, professor de inglês simpático e paciente para brasileiros. Conduza conversas em inglês simples, adequadas ao nível do aluno (iniciante: frases curtas e palavras fáceis), sempre com UMA pergunta por vez para o aluno continuar. Responda de forma natural ao que o aluno disse. Se o aluno escrever em inglês com erros, comece com a correção neste formato exato:\n✏️ Você escreveu: <frase do aluno>\n✅ Forma correta: <frase corrigida>\n💡 Explicação: <uma frase curta em português>\nDepois continue a conversa em inglês. Se não houver erros, elogie em uma frase curta e continue. Se o aluno escrever em português, ajude a dizer em inglês e peça para repetir. Explicações sempre em português simples, sem termos técnicos. Seja breve e incentive o aluno.";
const APP=(process.env.APP_URL||'http://localhost:'+PORT).replace(/\/$/,''),MP=process.env.MP_ACCESS_TOKEN,MPB=process.env.MP_API||'https://api.mercadopago.com',PRICE=+(process.env.PRICE||29.9),DAYS=+(process.env.DAYS||30);
db.exec('CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY,uid INTEGER,at TEXT)');
const esc=x=>String(x).replace(/[<>&"]/g,'');
const mail=async(to,subject,html)=>{if(!process.env.RESEND_API_KEY){console.log('EMAIL (sem RESEND_API_KEY) para',to,'|',subject,'|',html);return}try{await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.EMAIL_FROM,to:[to],subject,html})})}catch(e){console.error('email falhou',e)}};
const pwLink=u=>APP+'/#senha='+sign(u.id,'pw',2*864e5);
const okSig=(req,id)=>{const sec=process.env.MP_WEBHOOK_SECRET;if(!sec)return true;const h=String(req.headers['x-signature']||''),ts=(h.match(/ts=([^,]+)/)||[])[1],v1=(h.match(/v1=([^,]+)/)||[])[1];if(!ts||!v1)return false;const x=crypto.createHmac('sha256',sec).update(`id:${String(id).toLowerCase()};request-id:${req.headers['x-request-id']||''};ts:${ts};`).digest('hex');return x.length===v1.length&&crypto.timingSafeEqual(Buffer.from(x),Buffer.from(v1))};
const activate=async pid=>{const r=await fetch(MPB+'/v1/payments/'+encodeURIComponent(pid),{headers:{Authorization:'Bearer '+MP}});const pay=await r.json();if(pay.status!=='approved'||+pay.transaction_amount<PRICE)return;const u=byId(+pay.external_reference);if(!u)return;
 if(db.prepare('INSERT OR IGNORE INTO payments(id,uid,at) VALUES(?,?,?)').run(String(pid),u.id,td()).changes===0)return;
 const base=u.plan==='premium'&&u.exp>td()?u.exp:td(),d=new Date(base);d.setDate(d.getDate()+DAYS);const exp=d.toISOString().slice(0,10);
 db.prepare("UPDATE users SET plan='premium',exp=? WHERE id=?").run(exp,u.id);
 await mail(u.e,'Seu acesso ao Inglês do Zero está liberado! 🎉',`<p>Olá, ${esc(u.n)}! Pagamento confirmado. Acesso Premium até ${exp}.</p><p><a href="${pwLink(u)}">Clique aqui para criar sua senha</a> (link válido por 2 dias) e depois entre em ${APP}</p>`)};

const validE=e=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e||'');
const server=http.createServer(async(req,res)=>{
 const send=(c,o,h={})=>{res.writeHead(c,{'Content-Type':'application/json','X-Content-Type-Options':'nosniff',...h});res.end(JSON.stringify(o))};
 try{const url=new URL(req.url,'http://x'),p=url.pathname,m=req.method;
 if(!p.startsWith('/api/')){if(p==='/'||p==='/index.html'||p==='/comprar'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff'});return res.end(fs.readFileSync(path.join(__dirname,'index.html')))}res.writeHead(404);return res.end()}
 let b={};if(m!=='GET'){let s='';for await(const c of req){s+=c;if(s.length>2e5)return send(413,{error:'Muito grande'})}try{b=JSON.parse(s||'{}')}catch{return send(400,{error:'JSON inválido'})}}
 const ip=req.headers['x-forwarded-for']||req.socket.remoteAddress;

 if(p==='/api/webhook/mp'&&m==='POST'){const t=b.type||url.searchParams.get('type')||url.searchParams.get('topic'),pid=(b.data&&b.data.id)||url.searchParams.get('data.id')||url.searchParams.get('id');if(t!=='payment'||!pid)return send(200,{});if(!okSig(req,pid))return send(401,{});await activate(pid);return send(200,{})}
 if(p==='/api/buy'&&m==='POST'){const f=fails.get('b'+ip)||{n:0,t:Date.now()};if(Date.now()-f.t>9e5){f.n=0;f.t=Date.now()}if(++f.n>20)return send(429,{error:'Muitas tentativas.'});fails.set('b'+ip,f);
  const e=String(b.e||'').toLowerCase().trim();if(!validE(e)||!b.n)return send(400,{error:'Informe nome e e-mail válido.'});if(!MP)return send(503,{error:'Pagamento ainda não configurado.'});
  let u=byE(e);if(!u){mk(String(b.n).slice(0,80),'',e,crypto.randomBytes(8).toString('hex'),'gratis');u=byE(e)}
  const r=await fetch(MPB+'/checkout/preferences',{method:'POST',headers:{Authorization:'Bearer '+MP,'Content-Type':'application/json'},body:JSON.stringify({items:[{title:'Inglês do Zero Premium — '+DAYS+' dias',quantity:1,unit_price:PRICE,currency_id:'BRL'}],payer:{email:u.e},external_reference:String(u.id),notification_url:APP+'/api/webhook/mp',back_urls:{success:APP+'/#pago',pending:APP+'/#pago',failure:APP},auto_return:'approved'})});const j=await r.json();
  return j.init_point?send(200,{url:j.init_point}):send(502,{error:'Não foi possível iniciar o pagamento.'})}
 if(p==='/api/forgot'&&m==='POST'){const u=byE(String(b.e||'').toLowerCase().trim());if(u&&u.st!=='bloqueado')await mail(u.e,'Criar/redefinir sua senha',`<p><a href="${pwLink(u)}">Clique aqui para definir sua senha</a> (válido por 2 dias).</p>`);return send(200,{})}
 if(p==='/api/set-password'&&m==='POST'){const i=verify(String(b.t||''),'pw'),u=i&&byId(i);if(!u||String(b.p||'').length<6)return send(400,{error:'Link inválido/expirado ou senha curta (mín. 6).'});db.prepare('UPDATE users SET pw=? WHERE id=?').run(hash(b.p),u.id);return send(200,{token:sign(u.id),user:pub(byId(u.id))})}
 if(p==='/api/register'&&m==='POST'){const e=String(b.e||'').toLowerCase().trim();if(!b.n||!validE(e)||String(b.p||'').length<6)return send(400,{error:'Preencha nome, e-mail válido e senha (mín. 6).'});if(byE(e))return send(409,{error:'E-mail já cadastrado.'});const r=mk(String(b.n).slice(0,80),String(b.w||'').slice(0,30),e,b.p,'gratis');return send(200,{token:sign(r.lastInsertRowid),user:pub(byId(r.lastInsertRowid))})}
 if(p==='/api/login'&&m==='POST'){const f=fails.get(ip)||{n:0,t:Date.now()};if(Date.now()-f.t>9e5){f.n=0;f.t=Date.now()}if(f.n>=10)return send(429,{error:'Muitas tentativas. Aguarde 15 min.'});const u=byE(String(b.e||'').toLowerCase().trim());if(!u||!check(String(b.p||''),u.pw)){f.n++;fails.set(ip,f);return send(401,{error:'E-mail ou senha incorretos.'})}if(u.st==='bloqueado')return send(403,{error:'Acesso bloqueado. Fale com o suporte no WhatsApp.'});return send(200,{token:sign(u.id),user:pub(u)})}
 const id=verify((req.headers.authorization||'').slice(7)),u=id&&byId(id);if(!u||u.st==='bloqueado')return send(401,{error:'Sessão inválida.'});
 if(p==='/api/me'&&m==='GET')return send(200,{user:pub(u)});
 if(p==='/api/me'&&m==='PUT'){const ok=access(u),o=pub(u);const done=(Array.isArray(b.done)?b.done:[]).filter(i=>Number.isInteger(i)&&i>=0&&i<LESSONS.length&&(i<FREE||ok));const xp=Math.min(Math.max(0,+b.xp||0),o.xp+200);const rev=(Array.isArray(b.rev)?b.rev:[]).slice(0,200).map(r=>r.slice(0,6).map(x=>String(x).slice(0,120)));const days=(Array.isArray(b.days)?b.days:[]).slice(-400).map(String);
  db.prepare('UPDATE users SET xp=?,lvl=?,done=?,rev=?,days=? WHERE id=?').run(xp,String(b.lvl||'').slice(0,20),JSON.stringify(done),JSON.stringify(rev),JSON.stringify(days),u.id);return send(200,{})}
 if(p==='/api/lessons'&&m==='GET'){const ok=access(u);return send(200,{lessons:LESSONS.map((l,i)=>[l[0],l[1],l[2],(i<FREE||ok)?l[3]:null])})}

 if(p==='/api/trail'&&m==='GET'){const pr=getP(u),ok=access(u);return send(200,{prog:pr,levels:LV.map(l=>({id:l.id,name:l.name,mods:l.mods.map(md=>({id:md.id,title:md.title,soon:!(md.lessons||[]).length,open:modOK(u,md),prem:midx(md.id)>0&&!ok,test:!!MT[md.id],lessons:(md.lessons||[]).map(x=>({id:x.id,title:x.title}))}))}))})}
 const mL=p.match(/^\/api\/lesson\/([\w.]+)$/),mT=p.match(/^\/api\/modtest\/([\w.]+)$/);
 if(mL){const md=LES[mL[1]];if(!md||!canMod(u,md))return send(403,{error:'Aula bloqueada. Conclua o módulo anterior (nota 70%) ou assine o Premium.'});
  if(m==='GET')return send(200,{lesson:md.lessons.find(x=>x.id===mL[1])});
  if(m==='POST'){const pr=getP(u);pr.lessons=pr.lessons||{};pr.lessons[mL[1]]=Math.max(pr.lessons[mL[1]]||0,Math.min(100,Math.max(0,Math.round(+b.score||0))));setP(u,pr);return send(200,{prog:pr})}}
 if(mT){const md=MODS.find(x=>x.id===mT[1]),t=MT[mT[1]];if(!md||!t||!canMod(u,md))return send(403,{error:'Teste indisponível.'});const pr=getP(u);
  if(md.lessons.some(x=>pr.lessons==null||pr.lessons[x.id]==null))return send(403,{error:'Conclua todas as aulas do módulo antes do teste.'});
  if(m==='GET')return send(200,{questions:t.map(q=>({q:q.q,ops:q.ops}))});
  if(m==='POST'){const ans=Array.isArray(b.answers)?b.answers:[],sc=Math.round(t.filter((q,i)=>ans[i]===q.a).length/t.length*100);pr.mods=pr.mods||{};pr.mods[mT[1]]=Math.max(pr.mods[mT[1]]||0,sc);setP(u,pr);return send(200,{score:sc,pass:sc>=70,prog:pr})}}
 if(p==='/api/ai'&&m==='POST'){if(!access(u))return send(403,{error:'Recurso Premium.'});if(!GK)return send(503,{error:'Professor Alex ainda não configurado (falta a variável GEMINI_API_KEY no servidor).'});
  const a=aiUse.get(u.id)||{n:0,t:Date.now()};if(Date.now()-a.t>36e5){a.n=0;a.t=Date.now()}if(++a.n>60)return send(429,{error:'Limite de mensagens por hora atingido. Volte daqui a pouco!'});aiUse.set(u.id,a);
  const hist=(Array.isArray(b.history)?b.history:[]).slice(-12).map(x=>({role:x&&x.role==='model'?'model':'user',parts:[{text:String((x&&x.text)||'').slice(0,1500)}]}));while(hist.length&&hist[0].role==='model')hist.shift();
  const contents=[...hist,{role:'user',parts:[{text:String(b.prompt||'').slice(0,1500)}]}];
  let r,j,used;for(const md of GMODELS){used=md;try{r=await fetch(GBASE+'/v1beta/models/'+encodeURIComponent(md)+':generateContent',{method:'POST',headers:{'x-goog-api-key':GK,'content-type':'application/json'},body:JSON.stringify({systemInstruction:{parts:[{text:SYSAI}]},contents,generationConfig:{maxOutputTokens:1000,temperature:.7}})});j=await r.json()}catch(e){console.error('gemini falhou',e);return send(502,{error:'Não consegui falar com o Professor Alex agora. Tente de novo.'})}if(r.ok||(r.status!==404&&r.status!==403))break;console.error('gemini modelo indisponível',md,r.status)}
  if(!r.ok){const em=(j&&j.error&&j.error.message)||'';console.error('gemini erro',r.status,used,em);const dt=u.adm?` [admin: ${r.status} ${used} — ${em.slice(0,200)}]`:'';return send(r.status===429?429:502,{error:(r.status===429?'Muitos alunos usando agora. Tente de novo em 1 minuto.':(r.status===400||r.status===403||r.status===404)?'O Professor Alex está indisponível (verifique GEMINI_API_KEY e o modelo).':'Professor Alex indisponível no momento.')+dt})}
  const text=((j.candidates&&j.candidates[0]&&j.candidates[0].content&&j.candidates[0].content.parts)||[]).map(x=>x.text||'').join('').trim();
  if(text){const pr=getP(u);if(!pr.talk){pr.talk=1;setP(u,pr)}}return text?send(200,{text}):send(200,{text:'Não consegui responder essa. Tente reformular, por favor.'})}
 if(p.startsWith('/api/admin/')){if(!u.adm)return send(403,{error:'Somente administrador.'});
  if(p==='/api/admin/users'&&m==='GET')return send(200,{users:db.prepare('SELECT * FROM users WHERE adm=0 ORDER BY id DESC').all().map(pub)});
  if(p==='/api/admin/users'&&m==='POST'){const e=String(b.e||'').toLowerCase().trim();if(!b.n||!validE(e))return send(400,{error:'Nome e e-mail válido são obrigatórios.'});if(byE(e))return send(409,{error:'E-mail já cadastrado.'});mk(String(b.n).slice(0,80),String(b.w||'').slice(0,30),e,b.p||crypto.randomBytes(4).toString('hex'),b.plan==='premium'?'premium':'gratis',b.exp||td(30));return send(200,{})}
  if(p==='/api/admin/users'&&m==='PATCH'){const t=byE(String(b.e||''));if(!t||t.adm)return send(404,{error:'Aluno não encontrado.'});
   if(b.plan)db.prepare('UPDATE users SET plan=? WHERE id=?').run(b.plan==='premium'?'premium':'gratis',t.id);if(b.exp&&/^\d{4}-\d\d-\d\d$/.test(b.exp))db.prepare('UPDATE users SET exp=? WHERE id=?').run(b.exp,t.id);if(b.st)db.prepare('UPDATE users SET st=? WHERE id=?').run(b.st==='bloqueado'?'bloqueado':'ativo',t.id);if(b.p&&String(b.p).length>=6)db.prepare('UPDATE users SET pw=? WHERE id=?').run(hash(b.p),t.id);return send(200,{})}}
 send(404,{error:'Não encontrado'})}catch(e){console.error(e);send(500,{error:'Erro interno.'})}});
server.listen(PORT,()=>console.log('Rodando na porta '+PORT));
