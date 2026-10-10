// Pilote cloud Confort Maison — un passage : lit les réglages chiffrés, exécute l'application
// sans écran (même logique que sur le téléphone), enregistre l'état chiffré.
// Aucune donnée personnelle n'est écrite dans les journaux publics de GitHub.
const fs=require('fs'), path=require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const DATA=process.env.DATA_DIR||'data', APP=process.env.APP_FILE||'index.html';
const EMAIL=(process.env.MEL_EMAIL||'').trim(), PASS=process.env.MEL_PASSWORD||'';
const subtle=globalThis.crypto.subtle;
const b64=u8=>Buffer.from(u8).toString('base64'), unb64=s=>new Uint8Array(Buffer.from(s,'base64'));
async function key(){
  const enc=new TextEncoder();
  const base=await subtle.importKey('raw',enc.encode(PASS),'PBKDF2',false,['deriveKey']);
  return subtle.deriveKey({name:'PBKDF2',salt:enc.encode('confort-maison:'+EMAIL.toLowerCase()),iterations:150000,hash:'SHA-256'},
    base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function enc(obj,k){ const iv=globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct=await subtle.encrypt({name:'AES-GCM',iv},k,new TextEncoder().encode(JSON.stringify(obj)));
  return JSON.stringify({v:1,iv:b64(iv),ct:b64(new Uint8Array(ct))}); }
async function dec(txt,k){ const e=JSON.parse(txt);
  return JSON.parse(new TextDecoder().decode(await subtle.decrypt({name:'AES-GCM',iv:unb64(e.iv)},k,unb64(e.ct)))); }
const rd=f=>{ try{ return fs.readFileSync(path.join(DATA,f),'utf8'); }catch(e){ return null; } };

(async()=>{
  if(!EMAIL||!PASS){ console.log('⛔ Secrets MEL_EMAIL / MEL_PASSWORD absents : ajoutez-les dans Settings → Secrets → Actions.'); process.exit(1); }
  const k=await key();
  let cfg=null, st={};
  const cfgTxt=rd('config.json'), stTxt=rd('state.json');
  try{ if(cfgTxt) cfg=await dec(cfgTxt,k); }catch(e){ console.log('⚠️ Réglages illisibles (mot de passe MELCloud changé ?) — renvoyez-les depuis le téléphone.'); cfg=null; }
  try{ if(stTxt) st=await dec(stTxt,k); }catch(e){ st={}; }
  const now=Date.now();
  const out={v:1,lastRun:now,ok:false,reason:'',error:'',journal:(st.journal||[]).slice(0,40),
             S:st.S||null, remote:st.remote||{on:false,stamp:0}, dehumid:st.dehumid||{active:false}, clim:null};
  if(cfg && cfg.enabled===false){
    out.ok=true; out.reason='Pilote cloud désactivé depuis le téléphone';
    fs.writeFileSync(path.join(DATA,'state.json'),await enc(out,k)); console.log('⏸ désactivé'); return;
  }
  // Fusion mode télécommande / déshumidification : la décision la plus récente gagne
  const cRem=(cfg&&cfg.remote)||{on:false,stamp:0}, sRem=st.remote||{on:false,stamp:0};
  const remote=(cRem.stamp||0)>(sRem.stamp||0)?cRem:sRem;
  const cDh=(cfg&&cfg.dehumid)||{active:false,stamp:0}, sDh=st.dehumid||{active:false,stamp:0};
  const dehumid=(cDh.stamp||0)>(sDh.stamp||0)?cDh:sDh;
  const phoneActedSinceLastRun=(cRem.stamp||0)>(st.lastRun||0);
  const seeds={ mc_e:EMAIL, mc_p:PASS,
    cloudInit:JSON.stringify({ presence:cfg?.presence||'home', returnDatetime:cfg?.returnDatetime||null,
      remoteOn:!!remote.on, remoteStamp:remote.stamp||0, S:st.S||null,
      noDetect: !st.S || (phoneActedSinceLastRun && !cRem.on) }),
    dehumid:JSON.stringify(dehumid), journal:JSON.stringify(st.journal||[]) };
  if(cfg){
    if(cfg.pdata) seeds.pdata_v2=JSON.stringify(cfg.pdata);
    seeds.smartOn=String(cfg.smartOn!==false); seeds.userMode=cfg.userMode||'auto';
    if(cfg.vanePref) seeds.vanePref=JSON.stringify(cfg.vanePref);
    seeds.vaneHPref=cfg.vaneHPref==null?'null':String(cfg.vaneHPref); seeds.vaneHInvert=cfg.vaneHInvert?'1':'0';
  }
  const html=fs.readFileSync(APP,'utf8');
  const vc=new VirtualConsole(); const jsErr=[];
  vc.on('jsdomError',e=>jsErr.push(String(e.message||e).split('\n')[0]));
  const dom=new JSDOM(html,{runScripts:'dangerously',url:'https://pierreristerucci.github.io/confort-maison/',pretendToBeVisual:true,virtualConsole:vc,
    beforeParse(w){
      w.__CLOUD__=true; w.fetch=(u,o)=>fetch(u,o); w.confirm=()=>true; w.alert=()=>{};
      if(!w.AbortSignal.timeout) w.AbortSignal.timeout=()=>undefined;
      w.HTMLCanvasElement.prototype.getContext=()=>null;
      for(const [a,b] of Object.entries(seeds)) w.localStorage.setItem(a,b);
    }});
  const w=dom.window;
  const t0=Date.now(); while(!w.__CLOUD_DONE__ && Date.now()-t0<90000) await new Promise(r=>setTimeout(r,250));
  // S et mel sont des constantes du script : on les lit via eval (elles ne sont pas des propriétés de window)
  let S={}, raw=null; try{ S=w.eval('S')||{}; raw=w.eval('mel.raw')||null; }catch(e){}
  out.ok=!w.__CLOUD_ERROR__ && !!w.__CLOUD_DONE__;
  out.error=w.__CLOUD_ERROR__||(w.__CLOUD_DONE__?'':'délai dépassé');
  out.reason=S.remoteMode?'🎮 Télécommande prioritaire — le pilote attend que vous rendiez la main':(S.dehumid&&S.dehumid.active?'💧 Déshumidification surveillée':(S.lastReason||(S.smartOn===false?'Pilotage intelligent désactivé':'—')));
  out.S={on:S.on,setTemp:S.setTemp,opMode:S.opMode,fanSpeed:S.fanSpeed,_lastFanChange:S._lastFanChange||0,
         vane:S.vane,vaneH:S.vaneH,vaneHold:!!S.vaneHold,vaneHHold:!!S.vaneHHold,manualFan:!!S.manualFan};
  out.remote={on:!!S.remoteMode, stamp: S._remoteStamp||remote.stamp||0};
  out.dehumid=S.dehumid||{active:false}; if(out.dehumid && out.dehumid.active!==dehumid.active) out.dehumid.stamp=now;
  out.clim=raw?{on:raw.Power,setTemp:raw.SetTemperature,mode:raw.OperationMode,fan:raw.SetFanSpeed,room:raw.RoomTemperature,vane:raw.VaneVertical,vaneH:raw.VaneHorizontal}:null;
  try{ out.journal=JSON.parse(w.localStorage.getItem('journal')||'[]').slice(0,40); }catch(e){}
  if(jsErr.length) out.jsErrors=jsErr.slice(0,5);
  // n'écrire que si quelque chose a changé, ou au moins toutes les 30 min (limite les commits)
  const prevSig=JSON.stringify({...st,lastRun:0,journal:(st.journal||[]).slice(0,3)});
  const newSig=JSON.stringify({...out,lastRun:0,journal:out.journal.slice(0,3)});
  if(prevSig!==newSig || now-(st.lastRun||0)>=30*60000) fs.writeFileSync(path.join(DATA,'state.json'),await enc(out,k));
  console.log(out.ok?'✅ passage effectué':'❌ échec du passage (détail chiffré dans state.json)');
  dom.window.close(); process.exit(out.ok?0:1);
})().catch(e=>{ console.log('❌ erreur technique'); process.exit(1); });
