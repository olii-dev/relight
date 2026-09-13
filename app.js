/* RELIGHT v2 - cinematic F1 race replay library (FastF1 data, schema v2) */
'use strict';

const $ = id => document.getElementById(id);

const COMPOUND = {
  SOFT:{c:'#e8002d',l:'S'}, MEDIUM:{c:'#fff200',l:'M'}, HARD:{c:'#e8e8e8',l:'H'},
  INTERMEDIATE:{c:'#43b02a',l:'I'}, WET:{c:'#0067ad',l:'W'},
  UNKNOWN:{c:'#5a6270',l:'?'}
};
const STATUS_LABEL = {'1':['GREEN','status-green'],'2':['YELLOW','status-yellow'],
  '4':['SAFETY CAR','status-sc'],'5':['RED FLAG','status-red'],
  '6':['VIRTUAL SC','status-vsc'],'7':['VSC ENDING','status-vsc']};
const SPEEDS=[1,4,8,16,30,60];

/* ---------- global state ---------- */
let MANIFEST=null;          // data/races.json
let D=null;                 // loaded race data
let RACE_ID=null;
let byNum={};               // number -> driver + derived (crossings, laps, rows, rd)
let crossingsLap=[];
let moments=[];
let fastestLap=null;
let tStart=0, tEnd=0, totalLaps=0;
let t=0, speed=8, playing=true, focus=null;
let battle=null;            // {a:num,b:num}
let telemetryOn=false;
let lastFrame=0, finished=false;
let rowEls={};
let ticker={msg:null,since:0};
let mapInfo=null;
let trackGeom=null;         // {pts,cu,L}
let pitDelta=null;
let lastHashPush=0;
let toastTimer=null;

/* ================= helpers ================= */

function hexA(hex,a){
  const m=(hex||'#888888').replace('#','');
  const r=parseInt(m.substr(0,2),16),g=parseInt(m.substr(2,2),16),b=parseInt(m.substr(4,2),16);
  return `rgba(${r},${g},${b},${a})`;
}
function fmtGap(g){
  if(g==null||!isFinite(g)) return '--';
  if(Math.abs(g)<0.0005) return '0.000';
  if(g>0) return '+'+g.toFixed(3);
  return g.toFixed(3);
}
function fmtClock(sec){
  sec=Math.max(0,sec);
  const h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=Math.floor(sec%60);
  return h+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
}
function codeOf(num){ const d=byNum[num]; return d?d.code:'?'; }
function adjGap(ddRaw){
  // wrap-correct a race-distance difference for cars straddling the start/finish line
  if(ddRaw==null||!trackGeom) return ddRaw;
  const L=trackGeom.L;
  if(ddRaw>L/2) return ddRaw-L;
  if(ddRaw<-L/2) return ddRaw+L;
  return ddRaw;
}

/* ================= distance model =================
   Project every car sample onto the track polyline to get true race distance,
   enabling physical (not crossing-interpolated) live gaps. */

function buildTrackGeom(track){
  const pts=track;
  const n=pts.length;
  const cu=new Float64Array(n);
  let L=0;
  for(let i=1;i<n;i++){
    L+=Math.hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]);
    cu[i]=L;
  }
  L+=Math.hypot(pts[0][0]-pts[n-1][0],pts[0][1]-pts[n-1][1]); // closing segment
  return {pts,cu,L,n};
}

function projectRows(rows){
  // mutate rows: add .wl (within-lap track distance) and .vi (valid coords)
  if(!trackGeom) return;
  const {pts,cu,L,n}=trackGeom;
  let idx=0, haveIdx=false;
  for(let ri=0;ri<rows.length;ri++){
    const r=rows[ri];
    const x=r[1],y=r[2];
    r.vi=(x!==0||y!==0);
    if(!r.vi){ r.wl=ri>0?rows[ri-1].wl:null; continue; }
    // forward-biased local search with wraparound
    let best=-1,bd=Infinity;
    const lo=haveIdx?idx-24:0, span=haveIdx?72:n;
    for(let k=0;k<span;k++){
      const j=haveIdx?(((lo+k)%n)+n)%n:k;
      const dx=pts[j][0]-x,dy=pts[j][1]-y;
      const d2=dx*dx+dy*dy;
      if(d2<bd){bd=d2;best=j;}
    }
    if(best>=0){ idx=best;haveIdx=true; r.wl=cu[best]; }
    else r.wl=null;
  }
}

function withinLapAt(d,tNow){
  // interpolated within-lap distance, wrap-safe
  const rows=d.rows;
  if(!rows||!rows.length) return null;
  const L=trackGeom.L;
  let lo=0,hi=rows.length-1;
  if(tNow<=rows[0][0]) return rows[0].wl;
  if(tNow>=rows[hi][0]) return rows[hi].wl;
  while(lo<hi-1){const m=(lo+hi)>>1; if(rows[m][0]<=tNow) lo=m; else hi=m;}
  const a=rows[lo],b=rows[hi];
  let ca=a.wl,cb=b.wl;
  if(ca==null||cb==null) return ca!=null?ca:cb;
  if(cb<ca-L/2) cb+=L; else if(ca<cb-L/2) ca+=L;
  const f=(tNow-a[0])/((b[0]-a[0])||1);
  return (ca+(cb-ca)*f)%L;
}
function raceDistAt(d,tNow){
  // full race distance: official completed laps + within-lap projection
  if(!trackGeom) return null;
  const wl=withinLapAt(d,tNow);
  if(wl==null) return null;
  return completed(d,tNow)*trackGeom.L+wl;
}
function rateAt(d,tNow){
  // recent distance rate in track units/s
  const r1=raceDistAt(d,tNow),r0=raceDistAt(d,Math.max(tStart,tNow-6));
  if(r1==null||r0==null) return null;
  const dt=tNow-Math.max(tStart,tNow-6);
  if(dt<0.5) return null;
  const rate=(r1-r0)/dt;
  return rate>1?rate:null;
}
function gapSecs(distDiff,refDriver,tNow){
  // convert a distance difference to seconds using the reference car's speed
  if(distDiff==null) return null;
  let rate=refDriver?rateAt(refDriver,tNow):null;
  if(!rate){
    const med=medianGreenLap(refDriver);
    rate=med?trackGeom.L/med:trackGeom.L/100; // fallback: 100s lap
  }
  const g=distDiff/rate;
  if(g>599) return 599; if(g<-599) return -599;
  return g;
}

/* ================= data prep ================= */

function prepare(){
  totalLaps=D.meta.totalLaps;
  byNum={};crossingsLap=[];moments=[];fastestLap=null;pitDelta=null;
  trackGeom=buildTrackGeom(D.track);

  const carSrc=D.cars||D.positions||{};
  for(const dr of D.drivers){
    byNum[dr.number]=Object.assign({crossings:[],laps:[],rows:carSrc[dr.number]||[]},dr);
  }
  const active=new Set(D.laps.map(l=>l.driver));
  D.drivers=D.drivers.filter(dr=>active.has(dr.number));
  for(const n in byNum){ if(!active.has(n)) delete byNum[n]; }
  for(const l of D.laps){
    const d=byNum[l.driver];
    if(!d) continue;
    d.laps[l.lap]=l;
    if(l.lapEnd!=null) d.crossings.push({lap:l.lap,end:l.lapEnd,pos:l.position,time:l.time});
  }
  for(const n in byNum){
    byNum[n].crossings.sort((a,b)=>a.end-b.end);
    projectRows(byNum[n].rows);
  }

  tStart=Math.min(...D.laps.filter(l=>l.lap===1&&l.lapStart!=null).map(l=>l.lapStart));
  tEnd=D.meta.duration;

  // leader after each lap + lead-change moments
  let prevLeader=null;
  for(let k=1;k<=totalLaps;k++){
    let best=null;
    for(const n in byNum){
      const c=byNum[n].crossings.find(c=>c.lap===k);
      if(c&&c.pos===1){best={num:n,end:c.end};break;}
    }
    crossingsLap[k]=best;
    if(best&&prevLeader&&best.num!==prevLeader){
      moments.push({t:best.end,type:'lead',label:byNum[best.num].code+' LEADS'});
    }
    if(best) prevLeader=best.num;
  }

  // track status moments
  let prev='1';
  for(const s of D.trackStatus){
    if(s.time<tStart) continue;
    if(s.status==='4'&&prev!=='4') moments.push({t:s.time,type:'sc',label:'SAFETY CAR'});
    if(s.status==='6'&&prev!=='6') moments.push({t:s.time,type:'sc',label:'VIRTUAL SC'});
    if(s.status==='5'&&prev!=='5') moments.push({t:s.time,type:'red',label:'RED FLAG'});
    prev=s.status;
  }

  // fastest lap
  let fl=null;
  for(const l of D.laps){
    if(l.time!=null&&l.trackStatus==='1'&&(!fl||l.time<fl.time)) fl=l;
  }
  if(fl){
    fastestLap={driver:fl.driver,time:fl.time,setAt:fl.lapEnd,lap:fl.lap};
    moments.push({t:fl.lapEnd,type:'fl',label:'FASTEST LAP '+byNum[fl.driver].code});
  }

  // final lap + chequered
  const leaderFinal=byNum[prevLeader]?byNum[prevLeader].crossings[byNum[prevLeader].crossings.length-1]:null;
  if(leaderFinal){
    const lastLapStart=byNum[prevLeader].laps[leaderFinal.lap]?byNum[prevLeader].laps[leaderFinal.lap].lapStart:null;
    if(lastLapStart!=null) moments.push({t:lastLapStart,type:'lead',label:'FINAL LAP'});
    moments.push({t:leaderFinal.end,type:'cheq',label:'CHEQUERED FLAG'});
  }
  moments.unshift({t:tStart,type:'lead',label:'LIGHTS OUT'});
  moments.sort((a,b)=>a.t-b.t);

  // pit delta: median pit-lap time loss vs own green median
  const losses=[];
  for(const n in byNum){
    const d=byNum[n];
    const med=medianGreenLap(d);
    if(!med) continue;
    for(const l of d.laps){
      if(l&&l.pitIn!=null&&l.pitOut!=null&&l.time!=null&&med>0){
        const loss=l.time-med;
        if(loss>5&&loss<80) losses.push(loss);
      }
    }
  }
  if(losses.length){
    losses.sort((a,b)=>a-b);
    pitDelta=losses[Math.floor(losses.length/2)];
  }
}
function medianGreenLap(d){
  if(!d) return null;
  const ts=[];
  for(const l of d.laps){
    if(l&&l.time!=null&&l.trackStatus==='1'&&l.pitIn==null&&l.pitOut==null&&l.time>30&&l.time<220) ts.push(l.time);
  }
  if(ts.length<3) return null;
  ts.sort((a,b)=>a-b);
  return ts[Math.floor(ts.length/2)];
}

/* ================= race state queries ================= */

function completed(d,tNow){
  let lo=0,hi=d.crossings.length;
  while(lo<hi){const m=(lo+hi)>>1; if(d.crossings[m].end<=tNow) lo=m+1; else hi=m;}
  return lo;
}
function statusAt(tNow){
  let s='1';
  for(const e of D.trackStatus){ if(e.time<=tNow) s=e.status; else break; }
  return s;
}
function leaderAt(tNow){
  let best=null;
  for(const n in byNum){
    const d=byNum[n];
    const k=completed(d,tNow);
    let pos;
    if(k>0) pos=d.crossings[k-1].pos;
    else pos=d.grid||99;
    if(pos==null) pos=99;
    if(!best||pos<best.pos) best={num:n,pos};
  }
  return best?best.num:null;
}
function physOrder(tNow){
  // cars ranked by true race distance (only those with valid rd)
  const arr=[];
  for(const n in byNum){
    const rd=raceDistAt(byNum[n],tNow);
    if(rd!=null) arr.push({num:n,rd});
  }
  arr.sort((a,b)=>b.rd-a.rd);
  return arr;
}
function stateOf(d,tNow,leader){
  const k=completed(d,tNow);
  const curLap=Math.min(k+1,totalLaps);
  const lapRec=d.laps[curLap]||d.laps[k]||null;
  let pos;
  if(k>0) pos=d.crossings[k-1].pos; else pos=d.grid||99;

  let gap=null,lapped=0;
  if(k>0&&leader&&leader.number!==d.number){
    const lk=completed(leader,tNow);
    lapped=Math.max(0,lk-k);
  }
  // physical gap to official leader (truthful through mid-lap passes)
  const rdD=raceDistAt(d,tNow);
  let gapPhys=null;
  if(leader&&leader.number!==d.number&&rdD!=null){
    const rdL=raceDistAt(leader,tNow);
    if(rdL!=null){
      // laps down from race distance: a car may have crossed the line
      // (unlapping under SC) yet still be nearly a full lap behind.
      const ddL=rdL-rdD;
      lapped=Math.max(0,Math.round(ddL/trackGeom.L));
      gapPhys=gapSecs(lapped===0?adjGap(ddL):ddL,leader,tNow);
    }
  }

  let inPit=false,pitDur=null;
  if(lapRec&&lapRec.pitIn!=null&&lapRec.pitOut!=null){
    if(tNow>=lapRec.pitIn&&tNow<=lapRec.pitOut){inPit=true;}
    pitDur=lapRec.pitOut-lapRec.pitIn;
  }
  let compound=lapRec?lapRec.compound:null, tyreLife=lapRec?lapRec.tyreLife:null;

  const lastEnd=d.crossings.length?d.crossings[d.crossings.length-1].end:-1;
  const dnf=tNow>lastEnd+30&&!/Finished|Lapped|\+/.test(d.finalStatus||'')&&d.finalStatus!=='Finished';

  return {k,curLap,pos,gap,gapPhys,rd:rdD,lapped,inPit,pitDur,compound,tyreLife,dnf,lapRec};
}

/* ================= tower ================= */

function buildTower(){
  const tower=$('tower');
  tower.innerHTML=''; rowEls={};
  for(const dr of D.drivers){
    const el=document.createElement('div');
    el.className='row'; el.dataset.num=dr.number;
    el.innerHTML=`<div class="teambar" style="background:${dr.color}"></div>
      <div class="pos">-</div>
      <div class="code">${dr.code}</div>
      <div class="name">${dr.name}</div>
      <div class="tyre"></div>
      <div class="gap">-</div>
      <div class="int">-</div>`;
    el.addEventListener('click',()=>{ focus=(focus===dr.number?null:dr.number); updateFocusCard(); });
    tower.appendChild(el);
    rowEls[dr.number]=el;
  }
  layoutRows();
}
function layoutRows(){
  const tower=$('tower');
  const h=tower.clientHeight;
  const rh=Math.max(18,h/20);
  tower.style.setProperty('--row-h',rh+'px');
}
function renderTower(tNow){
  const leaderNum=leaderAt(tNow);
  const leader=byNum[leaderNum];
  const tower=$('tower');
  const rh=parseFloat(getComputedStyle(tower).getPropertyValue('--row-h'))||tower.clientHeight/20;
  const phys=physOrder(tNow);
  const physIdx={};
  phys.forEach((p,i)=>physIdx[p.num]=i);

  const states=[];
  for(const n in byNum){
    const d=byNum[n];
    const st=stateOf(d,tNow,leader);
    // interval: physical gap to the car physically ahead
    let int=null;
    const pi=physIdx[n];
    if(pi!=null&&pi>0){
      const ahead=phys[pi-1];
      const ddI=ahead.rd-phys[pi].rd;
      int=gapSecs(Math.round(ddI/trackGeom.L)===0?adjGap(ddI):ddI,byNum[ahead.num],tNow);
      if(int!=null&&int<0) int=0;
    }
    st.intPhys=int;
    states.push({d,st});
  }
  states.sort((a,b)=>{
    if(a.st.dnf&&!b.st.dnf) return 1;
    if(!a.st.dnf&&b.st.dnf) return -1;
    return (a.st.pos||99)-(b.st.pos||99);
  });

  states.forEach((s,idx)=>{
    const {d,st}=s; const el=rowEls[d.number];
    el.style.transform=`translateY(${idx*rh}px)`;
    el.classList.toggle('p1',idx===0&&!st.dnf);
    el.classList.toggle('p2',idx===1&&!st.dnf);
    el.classList.toggle('p3',idx===2&&!st.dnf);
    el.classList.toggle('out',st.dnf);
    el.classList.toggle('focused',focus===d.number);
    el.classList.toggle('battle-a',!!battle&&battle.a===d.number);
    el.classList.toggle('battle-b',!!battle&&battle.b===d.number);
    el.children[1].textContent=st.dnf?'OUT':(idx+1);

    const tyreEl=el.children[4];
    const cp=st.compound&&COMPOUND[st.compound]?COMPOUND[st.compound]:null;
    if(cp){
      const life=st.tyreLife||0;
      const wear=Math.max(0,100-life*3.2);
      tyreEl.innerHTML=`<div class="tyrechip" style="background:${cp.c};--wear:${wear};--ring:${cp.c}">${cp.l}</div>`;
      tyreEl.firstChild.title=st.tyreLife?st.tyreLife+' laps':'';
    } else tyreEl.innerHTML='';

    const gapEl=el.children[5], intEl=el.children[6];
    gapEl.classList.remove('ahead');
    if(idx===0&&!st.dnf){ gapEl.textContent='LEADER'; gapEl.style.color='var(--txt)'; intEl.textContent=''; }
    else if(st.dnf){ gapEl.textContent=d.finalStatus||'DNF'; gapEl.style.color='var(--txt-faint)'; intEl.textContent=''; }
    else if(st.lapped>0){
      gapEl.textContent='+'+st.lapped+(st.lapped>1?' LAPS':' LAP'); gapEl.style.color='var(--txt-dim)';
      intEl.textContent=fmtGap(st.intPhys);
    }
    else {
      const g=st.gapPhys;
      gapEl.textContent=fmtGap(g);
      if(g!=null&&g<-0.0005){ gapEl.classList.add('ahead'); gapEl.style.color=''; }
      else gapEl.style.color='';
      intEl.textContent=fmtGap(st.intPhys);
    }

    const int=st.intPhys;
    el.classList.toggle('drs',int!=null&&int<1.0&&int>=0&&!st.dnf);

    let badge=el.querySelector('.pitbadge');
    if(st.inPit){
      if(!badge){badge=document.createElement('div');badge.className='pitbadge';el.appendChild(badge);}
      badge.textContent='PIT';
    } else if(badge) badge.remove();

    if(fastestLap&&fastestLap.driver===d.number&&tNow>=fastestLap.setAt){
      el.classList.add('flash-fl');
      if(!el.querySelector('.flbadge')){
        const b=document.createElement('span');b.className='flbadge';b.textContent='FL';
        el.children[2].appendChild(b);
      }
    } else el.classList.remove('flash-fl');
  });

  if(leader){
    const lk=completed(leader,tNow);
    $('lap-cur').textContent='LAP '+Math.min(lk+1,totalLaps);
    $('lap-total').textContent='/'+totalLaps;
  }
}

/* ================= track map ================= */

function setupMap(){
  const c=$('trackmap');
  const redraw=()=>{ mapInfo=computeMapTransform(c); };
  window.addEventListener('resize',()=>{ redraw(); layoutRows(); });
  redraw();
}
function computeMapTransform(c){
  const dpr=window.devicePixelRatio||1;
  const w=c.clientWidth,h=c.clientHeight;
  c.width=w*dpr; c.height=h*dpr;
  const xs=D.track.map(p=>p[0]),ys=D.track.map(p=>p[1]);
  const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  const pad=Math.min(w,h)*0.10;
  const sc=Math.min((w-2*pad)/(maxX-minX),(h-2*pad)/(maxY-minY));
  const ox=(w-(maxX-minX)*sc)/2, oy=(h-(maxY-minY)*sc)/2;
  return {c,ctx:c.getContext('2d'),dpr,w,h,sc,ox,oy,minX,maxY,
    toX:x=>ox+(x-minX)*sc, toY:y=>h-(oy+(y-minY)*sc)};
}
function carRowAt(d,tNow){
  const rows=d.rows;
  if(!rows||!rows.length) return null;
  let lo=0,hi=rows.length-1;
  if(tNow<=rows[0][0]) return rows[0].vi?{row:rows[0],idx:0}:null;
  if(tNow>=rows[hi][0]) return rows[hi].vi?{row:rows[hi],idx:hi}:null;
  while(lo<hi-1){const m=(lo+hi)>>1; if(rows[m][0]<=tNow) lo=m; else hi=m;}
  const a=rows[lo],b=rows[hi];
  if(!a.vi||!b.vi) return a.vi?{row:a,idx:lo}:(b.vi?{row:b,idx:hi}:null);
  const f=(tNow-a[0])/((b[0]-a[0])||1);
  const row=[tNow,
    a[1]+(b[1]-a[1])*f, a[2]+(b[2]-a[2])*f,
    a[3]!=null&&b[3]!=null?a[3]+(b[3]-a[3])*f:(a[3]!=null?a[3]:b[3]),
    a[4]!=null?a[4]:b[4], a[5]!=null?a[5]:b[5],
    a[6]!=null?a[6]:b[6], a[7]!=null?a[7]:b[7], a[8]!=null?a[8]:b[8]];
  { let ca=a.wl,cb=b.wl;
    if(ca!=null&&cb!=null){
      const L=trackGeom?trackGeom.L:0;
      if(L&&cb<ca-L/2) cb+=L; else if(L&&ca<cb-L/2) ca+=L;
      row.wl=(ca+(cb-ca)*f)%(L||1);
    } else row.wl=ca!=null?ca:cb; }
  row.vi=true;
  return {row,idx:lo};
}
function renderMap(tNow){
  if(!mapInfo) return;
  const {ctx,dpr,w,h}=mapInfo;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,w,h);

  // minisector coloring (duel telemetry): who was faster per segment this lap
  const msColors=duelMinisectors(tNow);

  ctx.beginPath();
  D.track.forEach((p,i)=>{ const x=mapInfo.toX(p[0]),y=mapInfo.toY(p[1]); i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
  ctx.closePath();
  ctx.lineCap='round';ctx.lineJoin='round';
  ctx.strokeStyle='rgba(255,255,255,.07)';ctx.lineWidth=13;ctx.stroke();
  if(msColors){
    // colored overlay per segment
    const pts=trackGeom.pts,cu=trackGeom.cu,L=trackGeom.L,segs=msColors.length;
    ctx.lineWidth=4;
    for(let s=0;s<segs;s++){
      if(!msColors[s]) continue;
      const d0=s*L/segs,d1=(s+1)*L/segs;
      ctx.beginPath();
      let started=false;
      for(let i=0;i<pts.length;i++){
        if(cu[i]>=d0&&cu[i]<=d1){
          const x=mapInfo.toX(pts[i][0]),y=mapInfo.toY(pts[i][1]);
          started?ctx.lineTo(x,y):ctx.moveTo(x,y);started=true;
        }
      }
      if(started){ctx.strokeStyle=msColors[s];ctx.stroke();}
    }
  } else {
    ctx.strokeStyle='rgba(255,255,255,.28)';ctx.lineWidth=2.5;ctx.stroke();
    // redraw base line over the fat one
  }
  if(msColors){
    // keep a thin white base under the colored sectors
    ctx.beginPath();
    D.track.forEach((p,i)=>{ const x=mapInfo.toX(p[0]),y=mapInfo.toY(p[1]); i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
    ctx.closePath();
    ctx.strokeStyle='rgba(255,255,255,.14)';ctx.lineWidth=1.2;ctx.stroke();
  }

  const s0=D.track[0];
  ctx.fillStyle='#fff';
  ctx.beginPath();ctx.arc(mapInfo.toX(s0[0]),mapInfo.toY(s0[1]),3.5,0,7);ctx.fill();

  const leaderNum=leaderAt(tNow);
  const leader=byNum[leaderNum];
  const nums=Object.keys(byNum);
  const drawList=nums.filter(n=>n!==focus&&n!==leaderNum&&(!battle||(battle.a!==n&&battle.b!==n)));
  if(leaderNum) drawList.push(leaderNum);
  if(battle){ if(battle.b!==leaderNum) drawList.push(battle.b); if(battle.a!==leaderNum) drawList.push(battle.a); }
  if(focus&&focus!==leaderNum&&(!battle||(focus!==battle.a&&focus!==battle.b))) drawList.push(focus);

  for(const n of drawList){
    const d=byNum[n];
    if(!d) continue;
    const st=stateOf(d,tNow,leader);
    const cr=carRowAt(d,tNow);
    if(!cr) continue;
    const p=cr.row;
    const x=mapInfo.toX(p[1]),y=mapInfo.toY(p[2]);

    const arr=d.rows;
    if(arr&&cr.idx!=null){
      ctx.beginPath();
      let started=false;
      for(let i=Math.max(0,cr.idx-7);i<=cr.idx;i++){
        if(!arr[i].vi) continue;
        const px=mapInfo.toX(arr[i][1]),py=mapInfo.toY(arr[i][2]);
        started?ctx.lineTo(px,py):ctx.moveTo(px,py); started=true;
      }
      ctx.lineTo(x,y);
      ctx.strokeStyle=hexA(d.color,.35);ctx.lineWidth=3;ctx.stroke();
    }

    const isF=n===focus, isL=n===leaderNum, isB=battle&&(battle.a===n||battle.b===n);
    const r=isF?8:(isL?6.5:(isB?6:5));
    ctx.save();
    ctx.shadowColor=d.color;ctx.shadowBlur=isF?22:12;
    ctx.globalAlpha=st.dnf?0.3:1;
    ctx.fillStyle=d.color;
    ctx.beginPath();ctx.arc(x,y,r,0,7);ctx.fill();
    ctx.shadowBlur=0;
    ctx.lineWidth=1.6;ctx.strokeStyle=isF?'#fff':(isB?'rgba(255,255,255,.8)':'rgba(0,0,0,.55)');ctx.stroke();
    ctx.restore();

    if(isF||isL||isB){
      ctx.font='700 11px Titillium Web, sans-serif';
      ctx.fillStyle='rgba(0,0,0,.75)';
      const tw=ctx.measureText(d.code).width;
      ctx.fillRect(x+9,y-16,tw+10,16);
      ctx.fillStyle='#fff';
      ctx.fillText(d.code,x+14,y-4);
    }
  }
}

/* ================= chrome: status, ticker, focus ================= */

function renderStatus(tNow){
  const chip=$('status-chip');
  let label,cls;
  if(finished){label='CHEQUERED';cls='status-finished';}
  else{
    const s=statusAt(tNow);
    const pair=STATUS_LABEL[s]||['GREEN','status-green'];
    label=pair[0];cls=pair[1];
    if(s==='1'&&tNow>tStart+120) label='RACING';
  }
  if(chip.textContent!==label){chip.textContent=label;chip.className=cls;}
  $('sc-banner').classList.toggle('hidden',cls!=='status-sc');
  $('sc-text').textContent='SAFETY CAR DEPLOYED';
}
function renderTicker(tNow){
  const box=$('rc-ticker');
  const msgs=D.messages.filter(m=>m.time!=null&&m.time<=tNow&&m.time>=tStart-10);
  const latest=msgs.length?msgs[msgs.length-1]:null;
  const now=performance.now();
  if(latest&&latest!==ticker.msg&&(now-ticker.since>1500||!ticker.msg)){
    ticker.msg=latest;ticker.since=now;
  }
  box.classList.toggle('with-telemetry',telemetryOn&&!$('telemetry-card').classList.contains('hidden'));
  if(ticker.msg&&tNow-ticker.msg.time<120){
    box.classList.remove('hidden');
    $('rc-text').textContent=ticker.msg.message;
  } else box.classList.add('hidden');
}
function updateFocusCard(){
  const card=$('focus-card');
  if(!focus){card.classList.add('hidden');return;}
  const d=byNum[focus];
  if(!d){focus=null;card.classList.add('hidden');return;}
  card.classList.remove('hidden');
  card.innerHTML=`<div class="fc-code" style="color:${d.color}">${d.code}</div>
    <div class="fc-name">${d.name} - ${d.team}</div>
    <div class="fc-row"><span>POS <b id="fc-pos">-</b></span><span>GAP <b id="fc-gap">-</b></span><span>TYRE <b id="fc-tyre">-</b></span></div>`;
}
function renderFocusCard(tNow){
  if(!focus)return;
  const leader=byNum[leaderAt(tNow)];
  const d=byNum[focus];
  if(!d) return;
  const st=stateOf(d,tNow,leader);
  const p=$('fc-pos'),g=$('fc-gap'),ty=$('fc-tyre');
  if(!p)return;
  p.textContent=st.dnf?'OUT':(st.pos||'-');
  g.textContent=st.lapped>0?'+'+st.lapped+' LAP':fmtGap(st.gapPhys);
  const cp=st.compound&&COMPOUND[st.compound]?COMPOUND[st.compound].l:'-';
  ty.textContent=cp+(st.tyreLife?' '+st.tyreLife+'L':'');
}

/* ================= telemetry ================= */

function hasTelemetry(num){
  const d=byNum[num];
  if(!d||!d.rows||!d.rows.length) return false;
  return d.rows[0].length>3;
}
function lapRows(d,lapNo){
  const lr=d.laps[lapNo];
  if(!lr||lr.lapStart==null) return null;
  const end=lr.lapEnd!=null?lr.lapEnd:Infinity;
  const out=[];
  for(const r of d.rows){
    if(r[0]>=lr.lapStart&&r[0]<=end&&r.vi) out.push(r);
  }
  return out.length>2?out:null;
}
function traceSeries(d,lapNo,tNow){
  // returns {s:[dist...], v:[speed...], t:[time...]} for a lap, cut at tNow
  const rows=lapRows(d,lapNo);
  if(!rows) return null;
  const base=rows[0].wl;
  if(base==null) return null;
  const L=trackGeom?trackGeom.L:0;
  const s=[],v=[],tm=[];
  for(const r of rows){
    if(r[0]>tNow) break;
    if(r.wl==null||r[3]==null) continue;
    s.push(((r.wl-base)%L+L)%L); v.push(r[3]); tm.push(r[0]);
  }
  // enforce monotonic s (projection noise)
  for(let i=1;i<s.length;i++){ if(s[i]<s[i-1]-L*0.02) s[i]=s[i-1]; }
  return s.length>2?{s,v,t:tm}:null;
}
function sizeCanvas(c){
  const dpr=window.devicePixelRatio||1;
  const w=c.clientWidth,h=c.clientHeight;
  if(c.width!==Math.round(w*dpr)||c.height!==Math.round(h*dpr)){
    c.width=Math.round(w*dpr);c.height=Math.round(h*dpr);
  }
  const ctx=c.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  return {ctx,w,h};
}
function drawTrace(canvas,seriesList,tNow,colors){
  const {ctx,w,h}=sizeCanvas(canvas);
  ctx.clearRect(0,0,w,h);
  const padL=6,padR=6,padT=8,padB=14;
  let maxS=0,maxV=0;
  for(const se of seriesList){
    if(!se) continue;
    if(se.ghost){for(let i=0;i<se.s.length;i++){maxS=Math.max(maxS,se.s[i]);maxV=Math.max(maxV,se.v[i]);}}
    else {for(let i=0;i<se.s.length;i++){maxV=Math.max(maxV,se.v[i]);}
      if(se.s.length) maxS=Math.max(maxS,se.s[se.s.length-1]);}
  }
  if(!maxS||!maxV) {ctx.fillStyle='rgba(255,255,255,.25)';ctx.font='10px Titillium Web';ctx.fillText('NO LAP DATA YET',padL+4,h/2);return;}
  maxV=Math.max(80,maxV*1.05);
  const X=s=>padL+(s/maxS)*(w-padL-padR);
  const Y=v=>h-padB-(v/maxV)*(h-padT-padB);
  // gridlines
  ctx.strokeStyle='rgba(255,255,255,.06)';ctx.lineWidth=1;
  for(let g=100;g<maxV;g+=100){
    ctx.beginPath();ctx.moveTo(padL,Y(g));ctx.lineTo(w-padR,Y(g));ctx.stroke();
    ctx.fillStyle='rgba(255,255,255,.22)';ctx.font='8px Titillium Web';ctx.fillText(g,padL+2,Y(g)-2);
  }
  for(const se of seriesList){
    if(!se) continue;
    ctx.beginPath();
    se.s.forEach((s,i)=>{ const x=X(s),y=Y(se.v[i]); i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
    if(se.ghost){
      ctx.strokeStyle='rgba(255,255,255,.18)';ctx.lineWidth=1.2;ctx.stroke();
    } else {
      ctx.strokeStyle=se.color;ctx.lineWidth=2;ctx.shadowColor=se.color;ctx.shadowBlur=6;ctx.stroke();ctx.shadowBlur=0;
      const lx=X(se.s[se.s.length-1]),ly=Y(se.v[se.v.length-1]);
      ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(lx,ly,3,0,7);ctx.fill();
    }
  }
}
function duelDelta(a,b){
  // time delta vs distance: positive = A ahead in time (reached distance earlier)
  if(!a||!b) return null;
  const n=Math.min(a.s.length,b.s.length);
  if(n<4) return null;
  const pts=[];
  const maxS=Math.min(a.s[a.s.length-1],b.s[b.s.length-1]);
  const step=maxS/120;
  let ia=0,ib=0;
  for(let d=0;d<=maxS;d+=step){
    while(ia<a.s.length-1&&a.s[ia]<d) ia++;
    while(ib<b.s.length-1&&b.s[ib]<d) ib++;
    pts.push({s:d,delta:b.t[ib]-a.t[ia]});
  }
  return pts;
}
function duelMinisectors(tNow){
  if(!(telemetryOn&&battle&&D.meta.telemetry)) return null;
  const A=byNum[battle.a],B=byNum[battle.b];
  if(!A||!B) return null;
  const lapA=Math.min(completed(A,tNow)+1,totalLaps);
  const lapB=Math.min(completed(B,tNow)+1,totalLaps);
  if(lapA!==lapB) return null;
  const sa=traceSeries(A,lapA,tNow),sb=traceSeries(B,lapB,tNow);
  if(!sa||!sb) return null;
  const SEGS=24;
  const maxS=Math.min(sa.s[sa.s.length-1],sb.s[sb.s.length-1]);
  if(maxS<trackGeom.L*0.15) return null;
  const out=new Array(SEGS).fill(null);
  let ia=0,ib=0;
  const tAt=(se,d,ptr)=>{
    while(ptr.i<se.s.length-1&&se.s[ptr.i]<d) ptr.i++;
    return se.t[ptr.i];
  };
  const pa={i:0},pb={i:0};
  let prevA=tAt(sa,0,pa),prevB=tAt(sb,0,pb);
  for(let s=1;s<=SEGS;s++){
    const d=s*maxS/SEGS;
    if(d>maxS) break;
    const ta=tAt(sa,d,pa),tb=tAt(sb,d,pb);
    const segA=ta-prevA,segB=tb-prevB;
    if(segA>0&&segB>0&&Math.abs(segA-segB)>0.01){
      out[s-1]=segA<segB?hexA(A.color,.6):hexA(B.color,.6);
    }
    prevA=ta;prevB=tb;
  }
  return out;
}
function renderTelemetry(tNow){
  const card=$('telemetry-card');
  const show=telemetryOn&&focus&&byNum[focus];
  card.classList.toggle('hidden',!show);
  if(!show) return;
  const d=byNum[focus];
  const tel=D.meta.telemetry&&hasTelemetry(focus);
  $('tc-code').textContent=d.code;
  $('tc-code').style.color=d.color;
  const cr=carRowAt(d,tNow);
  if(!tel||!cr){
    $('tc-speed').textContent=tel?'-':'N/A';
    $('tc-gear').textContent='-';
    $('tc-rpm').style.width='0%';$('tc-thr').style.width='0%';$('tc-brk').style.width='0%';
    $('tc-drs').classList.remove('on');
    if(!tel) $('tc-trace-note').textContent='telemetry not available for this race';
  } else {
    const r=cr.row;
    $('tc-speed').textContent=r[3]!=null?Math.round(r[3]):'-';
    $('tc-gear').textContent=r[6]!=null?r[6]:'-';
    $('tc-rpm').style.width=(r[7]!=null?Math.min(100,r[7]/130):0)+'%';
    $('tc-thr').style.width=(r[4]!=null?r[4]:0)+'%';
    $('tc-brk').style.width=(r[5]?100:0)+'%';
    $('tc-drs').classList.toggle('on',!!r[8]);
    $('tc-trace-note').textContent='speed vs distance - ghost: prev lap';
  }
  const curLap=Math.min(completed(d,tNow)+1,totalLaps);
  $('tc-lap-label').textContent='LAP '+curLap;
  const series=[];
  const cur=tel?traceSeries(d,curLap,tNow):null;
  const prev=tel&&curLap>1?traceSeries(d,curLap-1,Infinity):null;
  if(prev) series.push({s:prev.s,v:prev.v,t:prev.t,ghost:true});
  const duel=telemetryOn&&battle&&tel&&(battle.a===focus||battle.b===focus);
  $('tc-trace').classList.toggle('duel-mode',!!duel);
  if(duel){
    const other=byNum[battle.a===focus?battle.b:battle.a];
    const curLapO=Math.min(completed(other,tNow)+1,totalLaps);
    if(curLapO===curLap){
      const so=traceSeries(other,curLap,tNow);
      if(cur) series.push({s:cur.s,v:cur.v,t:cur.t,color:d.color});
      if(so) series.push({s:so.s,v:so.v,t:so.t,color:other.color});
      $('tc-trace-note').textContent=d.code+' vs '+other.code+' - overlaid, ghost: prev lap';
    } else {
      if(cur) series.push({s:cur.s,v:cur.v,t:cur.t,color:d.color});
    }
  } else if(cur) series.push({s:cur.s,v:cur.v,t:cur.t,color:d.color});
  drawTrace($('tc-trace'),series,tNow);
}

/* ================= battle ================= */

function battleGap(tNow){
  if(!battle) return null;
  const A=byNum[battle.a],B=byNum[battle.b];
  if(!A||!B) return null;
  const rdA=raceDistAt(A,tNow),rdB=raceDistAt(B,tNow);
  if(rdA==null||rdB==null) return null;
  const ddRaw=rdA-rdB;
  const dd=Math.round(ddRaw/trackGeom.L)===0?adjGap(ddRaw):ddRaw;
  const lead=dd>=0?A:B;
  return gapSecs(dd,lead,tNow); // >0: A ahead
}
function renderBattle(tNow){
  const card=$('battle-card');
  card.classList.toggle('hidden',!battle);
  if(!battle) return;
  const A=byNum[battle.a],B=byNum[battle.b];
  if(!A||!B){battle=null;card.classList.add('hidden');return;}
  const stA=stateOf(A,tNow,byNum[leaderAt(tNow)]);
  const stB=stateOf(B,tNow,byNum[leaderAt(tNow)]);
  const tyreBlock=(d,st)=>{
    const cp=st.compound&&COMPOUND[st.compound]?COMPOUND[st.compound]:COMPOUND.UNKNOWN;
    return `<div class="bd-code" style="color:${d.color}">${d.code}</div>
      <span class="bd-team">${d.team}</span>
      <div class="bd-tyre"><span class="mini-tyre" style="background:${cp.c}">${cp.l}</span>${st.tyreLife||0}L</div>`;
  };
  $('bt-a').innerHTML=tyreBlock(A,stA);
  $('bt-b').innerHTML=tyreBlock(B,stB);
  const g=battleGap(tNow);
  if(g==null){
    $('bt-gap-val').textContent='--';$('bt-gap-note').textContent='GAP';
  } else {
    const ahead=g>=0?A:B;
    $('bt-gap-val').textContent=Math.abs(g).toFixed(3);
    $('bt-gap-val').style.color=ahead.color;
    $('bt-gap-note').textContent=ahead.code+' AHEAD';
  }
  // flags
  const flags=[];
  const ag=g!=null?Math.abs(g):null;
  if(ag!=null&&ag>0.0005&&ag<1.0) flags.push(['DRS RANGE','drs',false]);
  const lifeA=stA.tyreLife||0,lifeB=stB.tyreLife||0;
  const off=lifeA-lifeB;
  if(Math.abs(off)>=3) flags.push([(off>0?A.code+' +'+off+'L OLDER':B.code+' +'+(-off)+'L OLDER'),'pitdelta',false]);
  if(pitDelta!=null){
    flags.push(['PIT LOSS ~'+pitDelta.toFixed(1)+'S','pitdelta',true]);
    if(ag!=null&&ag<pitDelta){
      const chaserFresher=(g>=0&&off<=-4)||(g<0&&off>=4);
      const leaderFresher=(g>=0&&off>=4)||(g<0&&off<=-4);
      if(chaserFresher) flags.push(['UNDERCUT THREAT','undercut',true]);
      else if(leaderFresher) flags.push(['OVERCUT WINDOW','overcut',true]);
    }
  }
  $('bt-flags').innerHTML=flags.map(f=>`<span class="bt-flag ${f[1]}${f[2]?' est':''}"${f[2]?' title="estimate"':''}>${f[0]}${f[2]?' (EST)':''}</span>`).join('');
  // chart
  const {ctx,w,h}=sizeCanvas($('bt-chart'));
  ctx.clearRect(0,0,w,h);
  const span=tNow-tStart;
  if(span>10&&g!=null){
    const N=Math.min(240,Math.floor(span/4));
    const pts=[];
    let maxAbs=1.5;
    for(let i=0;i<=N;i++){
      const tx=tStart+span*i/N;
      const gx=battleGap(tx);
      if(gx!=null){pts.push([tx,gx]);maxAbs=Math.max(maxAbs,Math.min(Math.abs(gx)*1.1,120));}
    }
    const X=tx=>( (tx-tStart)/span )*(w-8)+4;
    const Y=gx=>h/2-(gx/maxAbs)*(h/2-6);
    ctx.strokeStyle='rgba(255,255,255,.15)';ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(0,Y(0));ctx.lineTo(w,Y(0));ctx.stroke();
    // DRS band
    ctx.fillStyle='rgba(0,210,106,.07)';
    ctx.fillRect(4,Y(1),w-8,Y(-1)-Y(1));
    if(pts.length>1){
      ctx.beginPath();
      pts.forEach((p,i)=>{const x=X(p[0]),y=Y(p[1]);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});
      ctx.strokeStyle='#ffb800';ctx.lineWidth=1.8;ctx.stroke();
      ctx.lineTo(X(pts[pts.length-1][0]),Y(0));ctx.lineTo(X(pts[0][0]),Y(0));ctx.closePath();
      ctx.fillStyle='rgba(255,184,0,.12)';ctx.fill();
      const lx=X(pts[pts.length-1][0]),ly=Y(pts[pts.length-1][1]);
      ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(lx,ly,2.5,0,7);ctx.fill();
    }
  }
}

/* ================= share / hash ================= */

function buildHash(){
  const p=new URLSearchParams();
  if(RACE_ID) p.set('race',RACE_ID);
  p.set('t',Math.round(t-tStart));
  if(speed!==8) p.set('speed',speed);
  if(focus&&byNum[focus]) p.set('focus',byNum[focus].code);
  if(battle) p.set('battle',codeOf(battle.a)+','+codeOf(battle.b));
  if(telemetryOn) p.set('telemetry','1');
  return '#'+p.toString();
}
function pushHash(){
  const now=performance.now();
  if(now-lastHashPush<1200) return;
  lastHashPush=now;
  history.replaceState(null,'',buildHash());
}
function parseHash(){
  const h=location.hash.replace(/^#/,'');
  if(!h) return {};
  const p=new URLSearchParams(h);
  return {race:p.get('race'),t:parseFloat(p.get('t')||'0'),speed:parseInt(p.get('speed')||'8',10),
    focus:p.get('focus'),battle:p.get('battle'),telemetry:p.get('telemetry')==='1'};
}
function numFromCode(code){
  if(!code) return null;
  for(const n in byNum){ if(byNum[n].code===code) return n; }
  return null;
}
async function copyMomentLink(){
  pushHash();lastHashPush=0;pushHash();
  const url=location.origin+location.pathname+buildHash();
  try{ await navigator.clipboard.writeText(url); }
  catch(e){
    const ta=document.createElement('textarea');
    ta.value=url;document.body.appendChild(ta);ta.select();
    document.execCommand('copy');ta.remove();
  }
  toast('LINK COPIED');
}
function toast(msg){
  const el=$('toast');
  el.textContent=msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.classList.add('hidden'),1800);
}

/* ================= controls ================= */

function buildControls(){
  const grp=$('speed-group');
  grp.innerHTML='';
  SPEEDS.forEach(v=>{
    const b=document.createElement('button');
    b.className='spd'+(v===speed?' active':'');
    b.textContent=v+'x';
    b.onclick=()=>{speed=v;document.querySelectorAll('.spd').forEach(e=>e.classList.remove('active'));b.classList.add('active');};
    grp.appendChild(b);
  });
  const sc=$('scrubber');
  sc.oninput=()=>{
    t=tStart+(sc.value/1000)*(tEnd-tStart);
    finished=false;$('finish-overlay').classList.add('hidden');
  };
  const mk=$('timeline-markers');
  mk.innerHTML='';
  for(const m of moments){
    const e=document.createElement('div');
    e.className='tmarker '+m.type;
    e.style.left=((m.t-tStart)/(tEnd-tStart)*100)+'%';
    e.title=m.label;
    mk.appendChild(e);
  }
  const mc=$('moments');
  mc.innerHTML='';
  for(const m of moments){
    const b=document.createElement('button');
    b.className='moment '+m.type;
    const lap=lapAt(m.t);
    b.innerHTML=(lap?`<span class="m-lap">L${lap}</span>`:'')+m.label;
    b.onclick=()=>{t=m.t;finished=false;$('finish-overlay').classList.add('hidden');};
    mc.appendChild(b);
  }
}
function lapAt(tNow){
  const leader=byNum[leaderAt(tNow)];
  if(!leader)return null;
  return Math.min(completed(leader,tNow)+1,totalLaps);
}
function togglePlay(){setPlaying(!playing);}
function setPlaying(p){
  playing=p;
  $('icon-play').classList.toggle('hidden',p);
  $('icon-pause').classList.toggle('hidden',!p);
}
function renderTimeline(){
  const f=(t-tStart)/(tEnd-tStart);
  $('timeline-fill').style.width=(f*100)+'%';
  $('timeline-knob').style.left=(f*100)+'%';
  const sc=$('scrubber');
  if(document.activeElement!==sc) sc.value=Math.round(f*1000);
  $('race-clock').textContent=fmtClock(t-tStart);
}

/* ================= finish ================= */

function checkFinish(tNow){
  const leaderNum=crossingsLap[totalLaps]?crossingsLap[totalLaps].num:null;
  if(!leaderNum)return;
  const leader=byNum[leaderNum];
  const finalEnd=leader.crossings.length?leader.crossings[leader.crossings.length-1].end:null;
  if(finalEnd!=null&&tNow>=finalEnd&&!finished){
    finished=true;setPlaying(false);
    const pod=$('podium');pod.innerHTML='';
    const byFinal=[...D.drivers].sort((a,b)=>(a.finalPosition||99)-(b.finalPosition||99)).slice(0,3);
    byFinal.forEach((d,i)=>{
      const e=document.createElement('div');e.className='pod';
      e.innerHTML=`<span class="ppos">P${i+1}</span><span class="pteam" style="background:${d.color}"></span>
        <span class="pcode">${d.code}</span><span class="pname">${d.name}</span>`;
      pod.appendChild(e);
    });
    $('finish-overlay').classList.remove('hidden');
  }
}

/* ================= battle picker ================= */

let bpSel={a:null,b:null};
function openBattlePicker(){
  bpSel={a:battle?battle.a:null,b:battle?battle.b:null};
  renderBattlePicker();
  $('battle-picker').classList.remove('hidden');
}
function renderBattlePicker(){
  const grid=$('bp-grid');
  grid.innerHTML='';
  const leader=byNum[leaderAt(t)];
  const sorted=[...D.drivers].sort((x,y)=>{
    const sx=stateOf(byNum[x.number],t,leader),sy=stateOf(byNum[y.number],t,leader);
    return (sx.pos||99)-(sy.pos||99);
  });
  for(const dr of sorted){
    const d=byNum[dr.number];
    if(!d) continue;
    const st=stateOf(d,t,leader);
    const c=document.createElement('button');
    c.className='bp-chip'+(bpSel.a===d.number?' sel-a':'')+(bpSel.b===d.number?' sel-b':'');
    c.disabled=!!st.dnf;
    c.innerHTML=`<div class="c" style="color:${d.color}">${d.code}</div><div class="n">P${st.dnf?'OUT':st.pos||'-'} - ${d.team}</div>`;
    c.onclick=()=>{
      if(bpSel.a===d.number){bpSel.a=null;}
      else if(bpSel.b===d.number){bpSel.b=null;}
      else if(!bpSel.a){bpSel.a=d.number;}
      else if(!bpSel.b){bpSel.b=d.number;}
      else {bpSel.b=d.number;}
      renderBattlePicker();
    };
    grid.appendChild(c);
  }
  $('bp-slot-a').textContent='A: '+(bpSel.a?codeOf(bpSel.a):'-');
  $('bp-slot-b').textContent='B: '+(bpSel.b?codeOf(bpSel.b):'-');
  $('bp-go').disabled=!(bpSel.a&&bpSel.b);
}

/* ================= picker ================= */

function drawMiniTrack(canvas,track){
  const dpr=window.devicePixelRatio||1;
  const w=canvas.clientWidth||170,h=canvas.clientHeight||130;
  canvas.width=w*dpr;canvas.height=h*dpr;
  const ctx=canvas.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  const xs=track.map(p=>p[0]),ys=track.map(p=>p[1]);
  const minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
  const pad=8;
  const sc=Math.min((w-2*pad)/(maxX-minX),(h-2*pad)/(maxY-minY));
  const ox=(w-(maxX-minX)*sc)/2,oy=(h-(maxY-minY)*sc)/2;
  ctx.beginPath();
  track.forEach((p,i)=>{
    const x=ox+(p[0]-minX)*sc,y=h-(oy+(p[1]-minY)*sc);
    i?ctx.lineTo(x,y):ctx.moveTo(x,y);
  });
  ctx.closePath();
  ctx.lineCap='round';ctx.lineJoin='round';
  ctx.strokeStyle='rgba(255,255,255,.55)';ctx.lineWidth=2;ctx.stroke();
}
function buildPicker(){
  const grid=$('picker-grid');
  grid.innerHTML='';
  const races=[...MANIFEST.races].sort((a,b)=>b.year-a.year||b.date.localeCompare(a.date));
  for(const r of races){
    const c=document.createElement('button');
    c.className='race-card';
    const p1=r.podium&&r.podium[0];
    c.innerHTML=`
      ${r.telemetry?'<span class="rc-tel">TELEMETRY</span>':''}
      <div class="rc-year">${r.year}</div>
      <div class="rc-name">${r.event.replace(' Grand Prix','')}<span style="color:var(--red)"> GP</span></div>
      <div class="rc-loc">${r.location}, ${r.country}</div>
      ${r.tag?`<span class="rc-tag">${r.tag}</span>`:''}
      <div class="rc-meta"><span><b>${r.totalLaps}</b> LAPS</span><span><b>${fmtClock(r.duration).replace(/^0:/,'')}</b> RACE</span>
      ${p1?`<span class="rc-p1">WINNER <b style="color:${p1.color}">${p1.code}</b></span>`:''}</div>
      <canvas></canvas>`;
    c.onclick=()=>{ selectRace(r.id); };
    grid.appendChild(c);
    drawMiniTrack(c.querySelector('canvas'),r.track);
  }
}
function showPicker(){
  setPlaying(false);
  $('picker').classList.remove('hidden');
  $('battle-picker').classList.add('hidden');
}
function hidePicker(){ $('picker').classList.add('hidden'); }

/* ================= race lifecycle ================= */

async function selectRace(id,opts){
  opts=opts||{};
  $('picker').classList.add('hidden');
  $('loading').classList.remove('done');
  $('loading-status').textContent='LOADING RACE DATA';
  const entry=MANIFEST.races.find(r=>r.id===id);
  if(!entry){ showPicker(); return; }
  const res=await fetch(entry.file);
  if(!res.ok){ $('loading-status').textContent='FAILED TO LOAD RACE DATA'; return; }
  D=await res.json();
  RACE_ID=id;
  focus=null;battle=null;telemetryOn=!!opts.telemetry;finished=false;
  ticker={msg:null,since:0};
  $('loading-status').textContent='BUILDING RACE';
  await new Promise(r=>setTimeout(r,30));
  prepare();
  $('event-name').textContent=D.meta.year+' '+D.meta.event;
  $('event-circuit').textContent=(D.meta.location||'')+', '+(D.meta.country||'')+' - '+D.meta.totalLaps+' LAPS';
  document.title='RELIGHT - '+D.meta.year+' '+D.meta.event;
  buildTower();
  setupMap();
  buildControls();
  updateFocusCard();
  $('btn-telemetry').classList.toggle('active',telemetryOn);
  $('btn-battle').classList.remove('active');
  $('telemetry-card').classList.toggle('hidden',!telemetryOn);
  t=tStart+(opts.t||0);
  if(opts.speed&&SPEEDS.includes(opts.speed)) speed=opts.speed;
  if(opts.focus) focus=numFromCode(opts.focus);
  if(opts.battle){
    const parts=opts.battle.split(',');
    const a=numFromCode(parts[0]),b=numFromCode(parts[1]);
    if(a&&b&&a!==b){ battle={a,b}; $('btn-battle').classList.add('active'); }
  }
  updateFocusCard();
  setPlaying(!opts.paused);
  lastFrame=performance.now();
  setTimeout(()=>$('loading').classList.add('done'),350);
  pushHash();
}

/* ================= main loop ================= */

function frame(now){
  const dtReal=Math.min(0.1,(now-lastFrame)/1000);lastFrame=now;
  if(playing&&!finished&&D){t=Math.min(tEnd,t+dtReal*speed);}
  if(D){
    renderTower(t);
    renderMap(t);
    renderStatus(t);
    renderTicker(t);
    renderFocusCard(t);
    renderTelemetry(t);
    renderBattle(t);
    renderTimeline();
    checkFinish(t);
    pushHash();
  }
  requestAnimationFrame(frame);
}

/* ================= boot ================= */

function bindStatic(){
  $('btn-play').onclick=togglePlay;
  $('btn-restart').onclick=()=>{t=tStart;finished=false;$('finish-overlay').classList.add('hidden');setPlaying(true);};
  $('replay-again').onclick=()=>$('btn-restart').click();
  $('finish-races').onclick=showPicker;
  $('finish-share').onclick=copyMomentLink;
  $('races-btn').onclick=showPicker;
  $('brand-home').onclick=showPicker;
  $('btn-share').onclick=copyMomentLink;
  $('btn-battle').onclick=()=>{
    if(!D) return;
    if(battle){battle=null;$('btn-battle').classList.remove('active');}
    else openBattlePicker();
  };
  $('bp-cancel').onclick=()=>$('battle-picker').classList.add('hidden');
  $('bp-go').onclick=()=>{
    battle={a:bpSel.a,b:bpSel.b};
    $('btn-battle').classList.add('active');
    $('battle-picker').classList.add('hidden');
  };
  $('bt-close').onclick=()=>{battle=null;$('btn-battle').classList.remove('active');};
  $('bt-swap').onclick=()=>{if(battle){battle={a:battle.b,b:battle.a};}};
  $('btn-telemetry').onclick=()=>{
    if(!D) return;
    telemetryOn=!telemetryOn;
    if(telemetryOn&&!focus){
      const ln=leaderAt(t);
      if(ln){focus=ln;updateFocusCard();}
    }
    $('btn-telemetry').classList.toggle('active',telemetryOn);
  };
  $('tc-close').onclick=()=>{telemetryOn=false;$('btn-telemetry').classList.remove('active');};
  document.addEventListener('keydown',e=>{
    if(e.target&&/INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if(!$('picker').classList.contains('hidden')) return;
    if(e.code==='Space'){e.preventDefault();togglePlay();}
    else if(e.key==='ArrowRight')t=Math.min(tEnd,t+10);
    else if(e.key==='ArrowLeft')t=Math.max(tStart,t-10);
    else if(e.key==='r'||e.key==='R')$('btn-restart').click();
    else if(e.key==='b'||e.key==='B')$('btn-battle').click();
    else if(e.key==='t'||e.key==='T')$('btn-telemetry').click();
  });
}
async function boot(){
  bindStatic();
  const res=await fetch('data/races.json');
  MANIFEST=await res.json();
  buildPicker();
  const opts=parseHash();
  requestAnimationFrame(frame);
  if(opts.race&&MANIFEST.races.find(r=>r.id===opts.race)){
    await selectRace(opts.race,opts);
  } else {
    showPicker();
    setTimeout(()=>$('loading').classList.add('done'),300);
  }
}
boot().catch(e=>{
  $('loading-status').textContent='FAILED TO LOAD';
  console.error(e);
});
