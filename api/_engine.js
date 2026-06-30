/* ============================================================================
   ORBIT — Engine (v3, route-based / always-moving)

   Dummy data is emitted in the EXACT shape real GPS is collected:
     LocationFix = { t: epoch ms, lat, lng, acc(m) }
   Everyone is always in motion along a continuous daily route, so closest
   approaches happen mid-transit. The processor solves the TRUE closest instant
   (continuous, between fixes). Swap point to go live: replace sampleRoute()
   with a reader of real recorded fixes. Nothing downstream changes.
   ========================================================================== */

function mulberry32(seed){let a=seed>>>0;return function(){a|=0;a=(a+0x6D2B79F5)|0;
  let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
function gauss(rng){let u=0,v=0;while(u===0)u=rng();while(v===0)v=rng();return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);}

/* ---- geo ---------------------------------------------------------------- */
const R=6371000;
function haversine(a,b){const dLat=(b.lat-a.lat)*Math.PI/180,dLng=(b.lng-a.lng)*Math.PI/180,
  la=a.lat*Math.PI/180,lb=b.lat*Math.PI/180;
  const h=Math.sin(dLat/2)**2+Math.cos(la)*Math.cos(lb)*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));}
const mPerLat=1/111111, mPerLng=lat=>1/(111111*Math.cos(lat*Math.PI/180));
function offM(pt,m,ang){return{lat:pt.lat+(m*Math.sin(ang))*mPerLat, lng:pt.lng+(m*Math.cos(ang))*mPerLng(pt.lat)};}

/* ---- world constants ---------------------------------------------------- */
const SEED=7, DAYS=90, DAY_START=360, DAY_END=1380, STEP_SEC=20;   // 20-second fixes, 06:00–23:00

const HOME_JOSH={lat:-26.6290,lng:153.0920};                     // Twin Waters
const SP={                                                        // Sunshine Coast spots
  MAROOCHY:{lat:-26.6580,lng:153.0920}, COTTON_TREE:{lat:-26.6540,lng:153.1010},
  MOOLOOLABA:{lat:-26.6810,lng:153.1180}, ALEX:{lat:-26.6700,lng:153.1100},
  USC:{lat:-26.7170,lng:153.0570}, MARKET:{lat:-26.6500,lng:153.0900},
  BEACH:{lat:-26.6520,lng:153.1035}, KAWANA:{lat:-26.6900,lng:153.1330},
  BRISBANE:{lat:-27.4698,lng:153.0251},
};

// friends. cross = chance of crossing Josh on a given day ('all' = every day);
// sep = [min,max] metres apart at the crossing; spots = where they tend to meet.
// sep = [min,max] metres for the day's closest approach. Close friends draw small,
// acquaintances draw large. Everyone has a real closest-approach event every day.
const FR=[
  {id:'tom', name:'Tom', color:'#7C9CB5', home:{lat:-26.6312,lng:153.0905}, sinceDays:540, sep:[15,150],   spots:['MARKET','BEACH','COTTON_TREE','MAROOCHY']},
  {id:'emma',name:'Emma',color:'#C39B86', home:{lat:-26.6350,lng:153.0965}, sinceDays:410, sep:[70,560],   spots:['COTTON_TREE','BEACH','ALEX'], travel:{days:[80,81,82],to:'BRISBANE'}},
  {id:'mia', name:'Mia', color:'#A98CB5', home:{lat:-26.6720,lng:153.0980}, sinceDays:300, sep:[150,1500], spots:['ALEX','COTTON_TREE','USC','BEACH']},
  {id:'ben', name:'Ben', color:'#8FA98C', home:{lat:-26.6620,lng:153.1080}, sinceDays:220, sep:[400,2200], spots:['MOOLOOLABA','KAWANA','ALEX']},
  {id:'kai', name:'Kai', color:'#B5A87C', home:{lat:-26.6450,lng:153.0700}, sinceDays:150, sep:[1100,2600],spots:['USC','MARKET','MAROOCHY']},
];

/* ---- per-(friend,day) plan (deterministic) ------------------------------ */
function planFor(fi, friend, day){
  const rng=mulberry32((0x9E3779B9 ^ (SEED*2654435761) ^ (day*1000003) ^ (fi*19349663))>>>0);
  if(friend.travel && friend.travel.days.includes(day)) return {type:'away', to:friend.travel.to, rng};
  const spot=friend.spots[Math.floor(rng()*friend.spots.length)];
  const tc=495+rng()*585;                                        // ~08:15–18:00, fractional minute
  const sep=friend.sep[0]+rng()*(friend.sep[1]-friend.sep[0]);
  const angF=rng()*6.283, dirJ=rng()*6.283, dirF=dirJ+1.0+rng()*2.0;
  return {type:'meet', spot, tc, sep, angF, dirJ, dirF, rng};
}

// build everyone's continuous routes for one day: [{t(min),lat,lng}, ...]
// a meeting = two skew paths converging to a true closest approach of exactly `sep`,
// offset perpendicular to the relative velocity so the paths never actually intersect.
function meetGeom(c, m){
  const jc=offM(c,6,m.rng()*6.283);                              // Josh's crossing point
  const vJ={x:Math.cos(m.dirJ),y:Math.sin(m.dirJ)}, vF={x:Math.cos(m.dirF),y:Math.sin(m.dirF)};
  const wx=vJ.x-vF.x, wy=vJ.y-vF.y, wl=Math.hypot(wx,wy)||1;
  const nx=-wy/wl, ny=wx/wl, side=m.angF<Math.PI?1:-1;          // unit vector perpendicular to relative velocity
  const pt=(ex,nn)=>({lat:jc.lat+nn*mPerLat, lng:jc.lng+ex*mPerLng(jc.lat)});
  const L=320+m.rng()*820, ox=nx*m.sep*side, oy=ny*m.sep*side;   // varied speed (walk→brisk); closest (=sep) lands mid-segment at tc
  return {
    josh:[{t:m.tc-5,...pt(-vJ.x*L,-vJ.y*L)},{t:m.tc+5,...pt(vJ.x*L,vJ.y*L)}],
    friend:[{t:m.tc-5,...pt(ox-vF.x*L,oy-vF.y*L)},{t:m.tc+5,...pt(ox+vF.x*L,oy+vF.y*L)}],
  };
}
function buildDay(day){
  const plans=FR.map((f,fi)=>({f,fi,m:planFor(fi,f,day)}));
  // Josh: passes THROUGH each crossing, always moving
  const legs=[], geom={};
  for(const {f,m} of plans){ if(m.type==='meet'){ const g=meetGeom(SP[m.spot],m); geom[f.id]=g; legs.push({tc:m.tc,pts:g.josh}); } }
  legs.sort((a,b)=>a.tc-b.tc);
  const josh=[{t:DAY_START,...HOME_JOSH}];
  if(legs.length===0) josh.push({t:720,...offM(SP.MAROOCHY,60,1.2)},{t:721,...offM(SP.MAROOCHY,60,1.4)});
  else for(const lg of legs) josh.push(...lg.pts);
  josh.push({t:DAY_END,...HOME_JOSH});
  // friends
  const friends={};
  for(const {f,fi,m} of plans){
    if(m.type==='away'){ const c=SP[m.to];
      friends[f.id]=[{t:DAY_START,...offM(c,40,0)},{t:660,...offM(c,700,1)},{t:1020,...offM(c,500,3.5)},{t:DAY_END,...offM(c,40,2)}];
    } else {
      friends[f.id]=[{t:DAY_START,...f.home}, ...geom[f.id].friend, {t:DAY_END,...f.home}];
    }
  }
  return {josh, friends};
}

/* ---- THE SWAP POINT: sample a route into real-shaped GPS fixes ---------- */
function routePos(route,minute){
  if(minute<=route[0].t)return route[0];
  if(minute>=route[route.length-1].t)return route[route.length-1];
  for(let i=0;i<route.length-1;i++){ if(minute<=route[i+1].t){
    const a=route[i],b=route[i+1],r=(minute-a.t)/Math.max(1e-6,b.t-a.t);
    return{lat:a.lat+(b.lat-a.lat)*r,lng:a.lng+(b.lng-a.lng)*r}; } }
  return route[route.length-1];
}
function sampleRoute(route, baseDate, rng){
  const fixes=[];
  for(let sec=DAY_START*60; sec<=DAY_END*60; sec+=STEP_SEC){
    const p=routePos(route, sec/60);
    const pp=offM(p, Math.abs(gauss(rng))*2.2, rng()*6.283);     // ~2 m GPS wander (open-sky)
    fixes.push({t:baseDate.getTime()+sec*1000, lat:+pp.lat.toFixed(6), lng:+pp.lng.toFixed(6), acc:+(4+Math.abs(gauss(rng))*6).toFixed(1)});
  }
  return fixes;
}

/* ---- processing: continuous TRUE closest approach ----------------------- */
// real apps smooth GPS before measuring; a moving average kills per-fix jitter
// without blurring straight-line travel, so the closest instant is well-defined.
function smoothFixes(fx){
  const n=fx.length,out=new Array(n),R=6;
  for(let i=0;i<n;i++){let la=0,lo=0,c=0;
    for(let j=i-R;j<=i+R;j++){const k=j<0?0:(j>=n?n-1:j);la+=fx[k].lat;lo+=fx[k].lng;c++;}
    out[i]={t:fx[i].t,lat:la/c,lng:lo/c,acc:fx[i].acc};}
  return out;
}
function posAtTime(fixes,t){
  if(t<=fixes[0].t)return{lat:fixes[0].lat,lng:fixes[0].lng};
  const last=fixes[fixes.length-1];
  if(t>=last.t)return{lat:last.lat,lng:last.lng};
  let lo=0,hi=fixes.length-1;
  while(hi-lo>1){const mid=(lo+hi)>>1;(fixes[mid].t<=t)?lo=mid:hi=mid;}
  const a=fixes[lo],b=fixes[hi],r=(t-a.t)/(b.t-a.t);
  return{lat:a.lat+(b.lat-a.lat)*r,lng:a.lng+(b.lng-a.lng)*r};
}
function processDay(meFixes,friendFixes){
  const ref=meFixes[meFixes.length>>1], cosR=Math.cos(ref.lat*Math.PI/180);
  const XY=ll=>({x:(ll.lng-ref.lng)*111111*cosR, y:(ll.lat-ref.lat)*111111});
  let bestD2=Infinity, tStar=meFixes[0].t;
  const aligned = meFixes.length===friendFixes.length
    && meFixes[0].t===friendFixes[0].t && meFixes[meFixes.length-1].t===friendFixes[friendFixes.length-1].t;
  if(aligned){
    // shared timestamp grid (recorded together) -> O(n), no per-point search
    for(let i=0;i<meFixes.length-1;i++){
      const ma=XY(meFixes[i]),mb=XY(meFixes[i+1]),fa=XY(friendFixes[i]),fb=XY(friendFixes[i+1]);
      const rax=ma.x-fa.x,ray=ma.y-fa.y, ux=(mb.x-fb.x)-rax, uy=(mb.y-fb.y)-ray, uu=ux*ux+uy*uy;
      let s=uu>1e-9?-(rax*ux+ray*uy)/uu:0; s=s<0?0:s>1?1:s;
      const dx=rax+ux*s,dy=ray+uy*s,d2=dx*dx+dy*dy;
      if(d2<bestD2){bestD2=d2;tStar=meFixes[i].t+(meFixes[i+1].t-meFixes[i].t)*s;}
    }
  }else{
    // general path for irregular / unaligned real device streams
    const lo=Math.max(meFixes[0].t,friendFixes[0].t), hi=Math.min(meFixes[meFixes.length-1].t,friendFixes[friendFixes.length-1].t);
    const set={};
    for(const f of meFixes) if(f.t>=lo&&f.t<=hi) set[f.t]=1;
    for(const f of friendFixes) if(f.t>=lo&&f.t<=hi) set[f.t]=1;
    const T=Object.keys(set).map(Number).sort((a,b)=>a-b);
    for(let i=0;i<T.length-1;i++){
      const ta=T[i],tb=T[i+1];
      const ma=XY(posAtTime(meFixes,ta)),mb=XY(posAtTime(meFixes,tb));
      const fa=XY(posAtTime(friendFixes,ta)),fb=XY(posAtTime(friendFixes,tb));
      const rax=ma.x-fa.x,ray=ma.y-fa.y, ux=(mb.x-fb.x)-rax, uy=(mb.y-fb.y)-ray, uu=ux*ux+uy*uy;
      let s=uu>1e-9?-(rax*ux+ray*uy)/uu:0; s=s<0?0:s>1?1:s;
      const dx=rax+ux*s,dy=ray+uy*s,d2=dx*dx+dy*dy;
      if(d2<bestD2){bestD2=d2;tStar=ta+(tb-ta)*s;}
    }
  }
  const lo=Math.max(meFixes[0].t,friendFixes[0].t), hi=Math.min(meFixes[meFixes.length-1].t,friendFixes[friendFixes.length-1].t);
  const closest=haversine(posAtTime(meFixes,tStar),posAtTime(friendFixes,tStar));
  // ONE shared clock: every frame is a single wall-clock instant (7:15 beside 7:15). For this data the
  // global-closest instant sits hours deep inside a long stretch of being together, so we anchor the
  // replay to the real CONVERGENCE instead: from when you were last ~1 km apart down to when you met.
  // That's where the actual travelling happens (usually one person walks in to a stationary other).
  // The long "sitting together" tail afterwards is compressed into a few frames so the dots settle onto
  // the true closest point at the end without wasting the whole replay on a frozen hug.
  const GAP=1000, STEP=10000, MIN_W=3.5*60000, MAX_W=12*60000;
  const ARRIVE=Math.max(40, closest*6);
  const dist=t=>haversine(posAtTime(meFixes,t),posAtTime(friendFixes,t));
  let tArr=tStar;                                            // when you first got close (met)
  if(closest<150){ while(tArr-STEP>=lo && dist(tArr-STEP)<ARRIVE) tArr-=STEP; }
  let tBeg=tArr;                                             // last time you were ~1 km apart before that
  while(tBeg-STEP>=lo && dist(tBeg-STEP)<GAP) tBeg-=STEP;
  if(tArr-tBeg<MIN_W) tBeg=Math.max(lo,tArr-MIN_W);
  if(tArr-tBeg>MAX_W) tBeg=tArr-MAX_W;
  // Sample the approach by MOTION rather than by clock: lay down a fine time grid, measure how far the
  // pair actually moves across each step, then pick frames at even *travelled-distance* intervals. This
  // keeps a steady visual speed, so the natural slow-down as they arrive doesn't read as a stall. Both
  // me/them at a frame still come from one real timestamp, so the dots stay time-locked.
  const NA=54, fine=[], step=Math.max(2000,(tArr-tBeg)/600);
  for(let t=tBeg;t<tArr;t+=step)fine.push(t); fine.push(tArr);
  const cum=[0];
  for(let i=1;i<fine.length;i++){
    const dm=haversine(posAtTime(meFixes,fine[i-1]),posAtTime(meFixes,fine[i]));
    const dt=haversine(posAtTime(friendFixes,fine[i-1]),posAtTime(friendFixes,fine[i]));
    cum.push(cum[i-1]+dm+dt);
  }
  const total=cum[cum.length-1]||1, replay=[];
  for(let j=0;j<NA;j++){ const target=total*j/(NA-1); let k=1; while(k<cum.length&&cum[k]<target)k++; if(k>=cum.length)k=cum.length-1;
    const seg=(cum[k]-cum[k-1])||1, fr=(target-cum[k-1])/seg, tr=fine[k-1]+(fine[k]-fine[k-1])*fr;
    replay.push({t:replay.length, me:posAtTime(meFixes,tr), them:posAtTime(friendFixes,tr)}); }
  // brief eased glide from the arrival positions onto the exact closest point (no slow real-drift crawl)
  const meEnd=posAtTime(meFixes,tStar), themEnd=posAtTime(friendFixes,tStar);
  const mA=replay[replay.length-1].me, tA2=replay[replay.length-1].them, NT=14;
  for(let j=1;j<=NT;j++){ const e=1-Math.pow(1-j/NT,3);
    replay.push({t:replay.length,
      me:{lat:mA.lat+(meEnd.lat-mA.lat)*e,lng:mA.lng+(meEnd.lng-mA.lng)*e},
      them:{lat:tA2.lat+(themEnd.lat-tA2.lat)*e,lng:tA2.lng+(themEnd.lng-tA2.lng)*e}}); }
  const ci=replay.length-1;
  function backIdx(who){let acc=0;for(let i=ci;i>0;i--){acc+=haversine(replay[i][who],replay[i-1][who]);if(acc>=GAP)return i-1;}return 0;}
  return{closest,closestT:tStar,replay,closestIndexInReplay:ci,meStartIdx:backIdx('me'),themStartIdx:backIdx('them')};
}

/* ---- build the world ---------------------------------------------------- */
function buildWorld(seed=SEED){
  const rng=mulberry32(seed);
  const today=new Date();today.setHours(0,0,0,0);
  const dates=[];for(let i=DAYS;i>=1;i--){const d=new Date(today);d.setDate(d.getDate()-i);dates.push(d);}
  const records={};FR.forEach(f=>records[f.id]=[]);

  for(let day=0;day<DAYS;day++){
    const rt=buildDay(day);
    const meFixes=smoothFixes(sampleRoute(rt.josh,dates[day],rng));
    const dayRecs=[];
    for(const f of FR){
      const fFixes=smoothFixes(sampleRoute(rt.friends[f.id],dates[day],rng));
      const r=processDay(meFixes,fFixes);
      const cT=new Date(r.closestT);
      const rec={friend:f.id,date:dates[day],dayIndex:day,
        closest:r.closest,closestT:r.closestT,closestMin:cT.getHours()*60+cT.getMinutes(),
        replay:r.replay,closestIndexInReplay:r.closestIndexInReplay,rank:0,badges:[]};
      records[f.id].push(rec);dayRecs.push(rec);
    }
    dayRecs.slice().sort((a,b)=>a.closest-b.closest).forEach((r,i)=>r.rank=i+1);
  }

  const friendData=FR.map(f=>{
    const recs=records[f.id],closest=recs.map(r=>r.closest);
    const sorted=closest.slice().sort((a,b)=>a-b), median=sorted[Math.floor(sorted.length/2)];
    const avg=closest.reduce((s,v)=>s+v,0)/closest.length, within=m=>recs.filter(r=>r.closest<=m).length;
    const furthest=Math.max(...closest),furthestDay=recs.find(r=>r.closest===furthest);
    const avgRank=recs.reduce((s,r)=>s+r.rank,0)/recs.length, daysNo1=recs.filter(r=>r.rank===1).length;
    const run=test=>{let cur=0,rec=0;for(const r of recs){if(test(r)){cur++;rec=Math.max(rec,cur);}else cur=0;}
      let trail=0;for(let i=recs.length-1;i>=0;i--){if(test(recs[i]))trail++;else break;}return{current:trail,record:rec};};
    const s1km=run(r=>r.closest<=1000),s100=run(r=>r.closest<=100),sNo1=run(r=>r.rank===1);
    if(furthest>25000)furthestDay.badges.push({icon:'🌍',label:'Furthest ever'});
    let c=0;for(const r of recs){if(r.closest<=1000){c++;if(c===30)r.badges.push({icon:'🔥',label:'30 days within 1 km'});}else c=0;}
    let n1=0;for(const r of recs){if(r.rank===1){n1++;if(n1===25)r.badges.push({icon:'🥇',label:'25 days ranked #1'});}}
    if(f.sinceDays>365)recs[0].badges.push({icon:'🏠',label:'First year together'});
    else if(f.sinceDays>100)recs[0].badges.push({icon:'🤝',label:'100 days together'});
    return{...f,records:recs,yesterday:recs[recs.length-1],median,avg,furthest,furthestDay:furthestDay.date,
      within100:within(100),within1k:within(1000),within5k:within(5000),avgRank,daysNo1,
      streak1km:s1km,streak100:s100,streakNo1:sNo1};
  });

  const leaderboard=friendData.slice().sort((a,b)=>a.median-b.median);
  return{me:{id:'josh',name:'Josh'},friends:friendData,leaderboard,dates,DAYS,home:HOME_JOSH};
}

if(typeof module!=='undefined')module.exports={buildWorld,haversine,mulberry32,processDay,smoothFixes,posAtTime,SEED,DAY_START,DAY_END};
