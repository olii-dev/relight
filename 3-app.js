/* RELIGHT - cinematic historical F1 race replay (FastF1 data) */
'use strict';

const $ = id => document.getElementById(id);
const DATA_URL = document.currentScript.dataset.src || 'race_2021_abudhabi.json';

const COMPOUND = {
  SOFT:{c:'#e8002d',l:'S'}, MEDIUM:{c:'#fff200',l:'M'}, HARD:{c:'#e8e8e8',l:'H'},
  INTERMEDIATE:{c:'#43b02a',l:'I'}, WET:{c:'#0067ad',l:'W'}
};
const STATUS_LABEL = {'1':['GREEN','status-green'],'2':['YELLOW','status-yellow'],
  '4':['SAFETY CAR','status-sc'],'5':['RED FLAG','status-red'],
  '6':['VIRTUAL SC','status-vsc'],'7':['VSC ENDING','status-vsc']};

let D=null;                 // data
let byNum={};               // number -> driver + derived
let crossingsLap=[];        // per lap: leader code etc
let moments=[];
let fastestLap=null;
let tStart=0, tEnd=0, totalLaps=0;
let t=0, speed=8, playing=true, focus=null;
let lastFrame=0, finished=false;
let rowEls={};
let ticker={msg:null,since:0};
let mapInfo=null;

/* ================= data prep ================= */

function prepare(D){
  totalLaps = D.meta.totalLaps;
  for(const dr of D.drivers){
    byNum[dr.number] = Object.assign({crossings:[],laps:[]},dr);
  }
  const active=new Set(D.laps.map(l=>l.driver));
  D.drivers = D.drivers.filter(dr => active.has(dr.number));
  for(const n in byNum){ if(!active.has(n)) delete byNum[n]; }
  for(const l of D.laps){
    const d = byNum[l.driver];
    if(!d) continue;
    d.laps[l.lap]=l;
    if(l.lapEnd!=null) d.crossings.push({lap:l.lap,end:l.lapEnd,pos:l.position,time:l.time});
  }
  for(const n in byNum) byNum[n].crossings.sort((a,b)=>a.end-b.end);

  // race start: earliest lap-1 start
  tStart=Math.min(...D.laps.filter(l=>l.lap===1&&l.lapStart!=null).map(l=>l.lapStart));
  tEnd=D.meta.duration;

  // leader after each lap + lead change moments
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
    if(l.time!=null && l.trackStatus==='1' && (!fl||l.time<fl.time)) fl=l;
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
}

/* ================= race state queries ================= */

function completed(d,tNow){
  // crossings are sorted; binary search count with end<=tNow
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
  // P1 by last completed lap, grid before first crossings
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
function leaderCrossingEnd(leader,lapIdx){
  // leader's crossing time ending lap lapIdx (1-based)
  const c=leader.crossings[lapIdx-1];
  return c?c.end:null;
}
function stateOf(d,tNow,leader){
  const k=completed(d,tNow);          // completed laps
  const curLap=Math.min(k+1,totalLaps);
  const lapRec=d.laps[curLap]||d.laps[k]||null;
  let pos;
  if(k>0) pos=d.crossings[k-1].pos; else pos=d.grid||99;

  // gap
  let gap=null, lapped=0;
  if(k>0&&leader&&leader.number!==d.number){
    const lk=completed(leader,tNow);
    lapped=Math.max(0,lk-k);
    const e_k=d.crossings[k-1].end;
    const l_k=leaderCrossingEnd(leader,k);
    if(l_k!=null&&lapped===0){
      const e_next=k<d.crossings.length?d.crossings[k].end:null;
      const l_next=leaderCrossingEnd(leader,k+1);
      const g0=e_k-l_k;
      if(e_next!=null&&l_next!=null){
        const g1=e_next-l_next;
        const f=Math.min(1,Math.max(0,(tNow-e_k)/(e_next-e_k)));
        gap=g0+(g1-g0)*f;
      } else gap=g0;
    }
  }
  // pit
  let inPit=false,pitDur=null;
  if(lapRec&&lapRec.pitIn!=null&&lapRec.pitOut!=null){
    if(tNow>=lapRec.pitIn&&tNow<=lapRec.pitOut){inPit=true;}
    pitDur=lapRec.pitOut-lapRec.pitIn;
  }
  // tyre
  let compound=lapRec?lapRec.compound:null, tyreLife=lapRec?lapRec.tyreLife:null;

  // dnf
  const lastEnd=d.crossings.length?d.crossings[d.crossings.length-1].end:-1;
  const dnf=tNow>lastEnd+30 && !/Finished|Lapped|\+/.test(d.finalStatus||'') && d.finalStatus!=='Finished';

  return {k,curLap,pos,gap,lapped,inPit,pitDur,compound,tyreLife,dnf,lapRec};
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
  window.addEventListener('resize',layoutRows);
}
function layoutRows(){
  const tower=$('tower');
  const h=tower.clientHeight;
  const rh=Math.max(18,h/20);
  tower.style.setProperty('--row-h',rh+'px');
}
function fmtGap(g){
  if(g==null) return '--';
  if(g<0.005) return '0.000';
  return '+'+g.toFixed(3);
}
function renderTower(tNow){
  const leaderNum=leaderAt(tNow);
  const leader=byNum[leaderNum];
  const tower=$('tower');
  const rh=parseFloat(getComputedStyle(tower).getPropertyValue('--row-h'))||tower.clientHeight/20;

  const states=[];
  for(const n in byNum){
    const d=byNum[n];
    const st=stateOf(d,tNow,leader);
    states.push({d,st});
  }
  states.sort((a,b)=>{
    if(a.st.dnf&&!b.st.dnf) return 1;
    if(!a.st.dnf&&b.st.dnf) return -1;
    return (a.st.pos||99)-(b.st.pos||99);
  });

  let prevGap=null;
  states.forEach((s,idx)=>{
    const {d,st}=s; const el=rowEls[d.number];
    el.style.transform=`translateY(${idx*rh}px)`;
    el.classList.toggle('p1',idx===0&&!st.dnf);
    el.classList.toggle('p2',idx===1&&!st.dnf);
    el.classList.toggle('p3',idx===2&&!st.dnf);
    el.classList.toggle('out',st.dnf);
    el.classList.toggle('focused',focus===d.number);
    el.children[1].textContent=st.dnf?'OUT':(idx+1);

    // tyre
    const tyreEl=el.children[4];
    const cp=st.compound&&COMPOUND[st.compound]?COMPOUND[st.compound]:null;
    if(cp){
      const life=st.tyreLife||0;
      const wear=Math.max(0,100-life*3.2);
      tyreEl.innerHTML=`<div class="tyrechip" style="background:${cp.c};--wear:${wear};--ring:${cp.c}">${cp.l}</div>`;
      tyreEl.firstChild.title=st.tyreLife?st.tyreLife+' laps':'';
    } else tyreEl.innerHTML='';

    // gaps
    const gapEl=el.children[5], intEl=el.children[6];
    if(idx===0){ gapEl.textContent='LEADER'; gapEl.style.color='var(--txt)'; intEl.textContent=''; }
    else if(st.dnf){ gapEl.textContent=d.finalStatus||'DNF'; gapEl.style.color='var(--txt-faint)'; intEl.textContent=''; }
    else if(st.lapped>0){ gapEl.textContent='+'+st.lapped+(st.lapped>1?' LAPS':' LAP'); gapEl.style.color='var(--txt-dim)'; intEl.textContent=fmtGap(st.gap!=null&&prevGap!=null?st.gap-prevGap:null); }
    else { gapEl.textContent=fmtGap(st.gap); gapEl.style.color=''; intEl.textContent=fmtGap(st.gap!=null&&prevGap!=null?st.gap-prevGap:null); }

    // DRS
    const int=(st.gap!=null&&prevGap!=null)?st.gap-prevGap:null;
    el.classList.toggle('drs',int!=null&&int<1.0&&int>=0&&!st.dnf);

    // pit badge
    let badge=el.querySelector('.pitbadge');
    if(st.inPit){
      if(!badge){badge=document.createElement('div');badge.className='pitbadge';el.appendChild(badge);}
      badge.textContent='PIT';
    } else if(badge) badge.remove();

    // fastest lap flash
    if(fastestLap&&fastestLap.driver===d.number&&tNow>=fastestLap.setAt){
      el.classList.add('flash-fl');
      if(!el.querySelector('.flbadge')){
        const b=document.createElement('span');b.className='flbadge';b.textContent='FL';
        el.children[2].appendChild(b);
      }
    } else el.classList.remove('flash-fl');

    if(idx===0) prevGap=0; else if(!st.dnf) prevGap=st.gap!=null?st.gap:prevGap;
  });

  // lap counter = leader lap
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
  window.addEventListener('resize',redraw);
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
function carXY(d,tNow){
  const arr=D.positions[d.number];
  if(!arr||!arr.length) return null;
  let lo=0,hi=arr.length-1;
  if(tNow<=arr[0][0]) return {x:arr[0][1],y:arr[0][2],t:arr[0][0]};
  if(tNow>=arr[hi][0]) return {x:arr[hi][1],y:arr[hi][2],t:arr[hi][0]};
  while(lo<hi-1){const m=(lo+hi)>>1; if(arr[m][0]<=tNow) lo=m; else hi=m;}
  const a=arr[lo],b=arr[hi];
  const f=(tNow-a[0])/(b[0]-a[0]||1);
  return {x:a[1]+(b[1]-a[1])*f, y:a[2]+(b[2]-a[2])*f, idx:lo};
}
function renderMap(tNow){
  if(!mapInfo) return;
  const {ctx,dpr,w,h}=mapInfo;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,w,h);

  // circuit
  ctx.beginPath();
  D.track.forEach((p,i)=>{ const x=mapInfo.toX(p[0]),y=mapInfo.toY(p[1]); i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
  ctx.closePath();
  ctx.lineCap='round';ctx.lineJoin='round';
  ctx.strokeStyle='rgba(255,255,255,.07)';ctx.lineWidth=13;ctx.stroke();
  ctx.strokeStyle='rgba(255,255,255,.28)';ctx.lineWidth=2.5;ctx.stroke();

  // start/finish dot
  const s0=D.track[0];
  ctx.fillStyle='#fff';
  ctx.beginPath();ctx.arc(mapInfo.toX(s0[0]),mapInfo.toY(s0[1]),3.5,0,7);ctx.fill();

  const leaderNum=leaderAt(tNow);
  const leader=byNum[leaderNum];
  // draw order: backmarkers first, leader + focus last
  const nums=Object.keys(byNum);
  const drawList=nums.filter(n=>n!==focus&&n!==leaderNum);
  if(leaderNum) drawList.push(leaderNum);
  if(focus&&focus!==leaderNum) drawList.push(focus);

  for(const n of drawList){
    const d=byNum[n];
    const st=stateOf(d,tNow,leader);
    const p=carXY(d,tNow);
    if(!p) continue;
    const x=mapInfo.toX(p.x),y=mapInfo.toY(p.y);

    // trail
    const arr=D.positions[n];
    if(arr&&p.idx!=null){
      ctx.beginPath();
      let started=false;
      for(let i=Math.max(0,p.idx-7);i<=p.idx;i++){
        const px=mapInfo.toX(arr[i][1]),py=mapInfo.toY(arr[i][2]);
        started?ctx.lineTo(px,py):ctx.moveTo(px,py); started=true;
      }
      ctx.lineTo(x,y);
      ctx.strokeStyle=hexA(d.color,.35);ctx.lineWidth=3;ctx.stroke();
    }

    const isF=n===focus, isL=n===leaderNum;
    const r=isF?8:(isL?6.5:5);
    ctx.save();
    ctx.shadowColor=d.color;ctx.shadowBlur=isF?22:12;
    ctx.globalAlpha=st.dnf?0.3:1;
    ctx.fillStyle=d.color;
    ctx.beginPath();ctx.arc(x,y,r,0,7);ctx.fill();
    ctx.shadowBlur=0;
    ctx.lineWidth=1.6;ctx.strokeStyle=isF?'#fff':'rgba(0,0,0,.55)';ctx.stroke();
    ctx.restore();

    if(isF||isL){
      ctx.font='700 11px Titillium Web, sans-serif';
      ctx.fillStyle='rgba(0,0,0,.75)';
      const tw=ctx.measureText(d.code).width;
      ctx.fillRect(x+9,y-16,tw+10,16);
      ctx.fillStyle='#fff';
      ctx.fillText(d.code,x+14,y-4);
    }
  }
}
function hexA(hex,a){
  const m=hex.replace('#','');
  const r=parseInt(m.substr(0,2),16),g=parseInt(m.substr(2,2),16),b=parseInt(m.substr(4,2),16);
  return `rgba(${r},${g},${b},${a})`;
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
function renderTicker(tNow,dtReal){
  const box=$('rc-ticker');
  const msgs=D.messages.filter(m=>m.time!=null&&m.time<=tNow&&m.time>=tStart-10);
  const latest=msgs.length?msgs[msgs.length-1]:null;
  const now=performance.now();
  if(latest&&latest!==ticker.msg&&(now-ticker.since>1500||!ticker.msg)){
    ticker.msg=latest;ticker.since=now;
  }
  if(ticker.msg&&tNow-ticker.msg.time<120){
    box.classList.remove('hidden');
    $('rc-text').textContent=ticker.msg.message;
  } else box.classList.add('hidden');
}
function updateFocusCard(){
  const card=$('focus-card');
  if(!focus){card.classList.add('hidden');return;}
  const d=byNum[focus];
  card.classList.remove('hidden');
  card.innerHTML=`<div class="fc-code" style="color:${d.color}">${d.code}</div>
    <div class="fc-name">${d.name} - ${d.team}</div>
    <div class="fc-row"><span>POS <b id="fc-pos">-</b></span><span>GAP <b id="fc-gap">-</b></span><span>TYRE <b id="fc-tyre">-</b></span></div>`;
}
function renderFocusCard(tNow){
  if(!focus)return;
  const leader=byNum[leaderAt(tNow)];
  const d=byNum[focus];
  const st=stateOf(d,tNow,leader);
  const p=$('fc-pos'),g=$('fc-gap'),ty=$('fc-tyre');
  if(!p)return;
  p.textContent=st.dnf?'OUT':(st.pos||'-');
  g.textContent=st.lapped>0?'+'+st.lapped+' LAP':fmtGap(st.gap);
  const cp=st.compound&&COMPOUND[st.compound]?COMPOUND[st.compound].l:'-';
  ty.textContent=cp+(st.tyreLife?' '+st.tyreLife+'L':'');
}

/* ================= controls ================= */

function fmtClock(sec){
  sec=Math.max(0,sec);
  const h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=Math.floor(sec%60);
  return h+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
}
function buildControls(){
  const speeds=[1,4,8,16,30,60];
  const grp=$('speed-group');
  speeds.forEach(v=>{
    const b=document.createElement('button');
    b.className='spd'+(v===speed?' active':'');
    b.textContent=v+'x';
    b.onclick=()=>{speed=v;document.querySelectorAll('.spd').forEach(e=>e.classList.remove('active'));b.classList.add('active');};
    grp.appendChild(b);
  });
  $('btn-play').onclick=togglePlay;
  $('btn-restart').onclick=()=>{t=tStart;finished=false;$('finish-overlay').classList.add('hidden');setPlaying(true);};
  const sc=$('scrubber');
  sc.oninput=()=>{
    t=tStart+(sc.value/1000)*(tEnd-tStart);
    finished=false;$('finish-overlay').classList.add('hidden');
  };
  // markers
  const mk=$('timeline-markers');
  for(const m of moments){
    const e=document.createElement('div');
    e.className='tmarker '+m.type;
    e.style.left=((m.t-tStart)/(tEnd-tStart)*100)+'%';
    e.title=m.label;
    mk.appendChild(e);
  }
  // moment chips
  const mc=$('moments');
  for(const m of moments){
    if(m.type==='red'&&false)continue;
    const b=document.createElement('button');
    b.className='moment '+m.type;
    const lap=lapAt(m.t);
    b.innerHTML=(lap?`<span class="m-lap">L${lap}</span>`:'')+m.label;
    b.onclick=()=>{t=m.t;finished=false;$('finish-overlay').classList.add('hidden');};
    mc.appendChild(b);
  }
  document.addEventListener('keydown',e=>{
    if(e.code==='Space'){e.preventDefault();togglePlay();}
    else if(e.key==='ArrowRight')t=Math.min(tEnd,t+10);
    else if(e.key==='ArrowLeft')t=Math.max(tStart,t-10);
    else if(e.key==='r'||e.key==='R')$('btn-restart').click();
  });
  $('replay-again').onclick=()=>$('btn-restart').click();
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

/* ================= main loop ================= */

function frame(now){
  const dtReal=Math.min(0.1,(now-lastFrame)/1000);lastFrame=now;
  if(playing&&!finished){t=Math.min(tEnd,t+dtReal*speed);}
  renderTower(t);
  renderMap(t);
  renderStatus(t);
  renderTicker(t,dtReal);
  renderFocusCard(t);
  renderTimeline();
  checkFinish(t);
  requestAnimationFrame(frame);
}

/* ================= boot ================= */

async function boot(){
  const res=await fetch(DATA_URL);
  D=await res.json();
  $('loading-status').textContent='BUILDING RACE';
  prepare(D);
  $('event-name').textContent=D.meta.year+' '+D.meta.event;
  $('event-circuit').textContent=(D.meta.location||'')+', '+(D.meta.country||'')+' - '+D.meta.totalLaps+' LAPS';
  buildTower();
  setupMap();
  buildControls();
  t=tStart;
  lastFrame=performance.now();
  requestAnimationFrame(frame);
  setTimeout(()=>$('loading').classList.add('done'),400);
}
boot().catch(e=>{
  $('loading-status').textContent='FAILED TO LOAD RACE DATA';
  console.error(e);
});
