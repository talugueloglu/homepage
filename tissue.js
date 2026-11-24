(()=>{
  'use strict';
  // =====================================================================================
  // A living epithelium, stippled.
  //
  // Geometry   Each cell is the exact region of the page nearest its centre, weighted by
  //            its size (a power diagram). Neighbours therefore share every border
  //            exactly; curved borders are one curve seen from both sides.
  // Mechanics  Each cell has a target area and adjusts its weight until it has it, and
  //            drifts toward the middle of its own region. Neighbours make room.
  // Events     Cells divide along their long axis; crowded cells are squeezed out and
  //            the gap closes. Lymphocytes and neutrophils crawl between the others.
  // Drawing    Every dot belongs to a cell and is stored in that cell's own coordinates,
  //            so it stays inside the cell however the cell deforms. The graphics card
  //            places the dots; density stays even because dots are thinned by area.
  // =====================================================================================
  let canvas=document.querySelector('canvas');
  const gl=canvas.getContext('webgl2',{antialias:false,premultipliedAlpha:false});
  const TAU=Math.PI*2,NA=40,HEAD=12,TW=HEAD+NA+1,STRIDE=8,MAXV=48,DYN_MAX=160000;
  const reduce=matchMedia('(prefers-reduced-motion: reduce)');
  const S=t=>t<=0?0:t>=1?1:t*t*(3-2*t),mix=(a,b,t)=>a+(b-a)*t,clamp=(v,a,b)=>v<a?a:v>b?b:v,rand=(a,b)=>a+Math.random()*(b-a);
  const randn=()=>{let u=0;for(let i=0;i<4;i++)u+=Math.random();return(u-2)*1.73;};
  const gapA=(a,b)=>{let d=(a-b)%TAU;if(d>Math.PI)d-=TAU;if(d<-Math.PI)d+=TAU;return d;};
  const hash=n=>{const x=Math.sin(n*127.1+311.7)*43758.5453;return(x-Math.floor(x))*2-1;};
  const LIGHT=(()=>{const v=[-.55,-.65,.75],l=Math.hypot(...v);return v.map(x=>x/l);})();
  const lit=(ca,sa,f)=>{f=Math.min(.999,f);const z=Math.sqrt(1-f*f),l=ca*f*LIGHT[0]+sa*f*LIGHT[1]+z*LIGHT[2];return l>0?l:0;};
  const accept=t=>t<=0?0:Math.min(1,Math.pow(t,1.15)*.95);
  const COS=new Float32Array(NA),SIN=new Float32Array(NA);for(let a=0;a<NA;a++){COS[a]=Math.cos(a/NA*TAU);SIN[a]=Math.sin(a/NA*TAU);}

  let W=0,H=0,DH=0,CT=0,CH=0,dpr=1,dpr0=1,size=60,colors={},time=0,last=0,frameNo=0,paused=false,started=false;
  let cells=[],pool=[],events=[],fading=[],procs=[],box=null,gpu=null,table=null,lam=1,beat=0,baseCount=0,nextEvent=3,lastEvent='ext';
  const scrollY=()=>window.scrollY||0;
  const readColors=()=>{const s=getComputedStyle(document.documentElement),g=n=>s.getPropertyValue(n).trim();colors={paper:g('--paper'),ink:g('--dot-ink'),dna:g('--dot-dna'),lyso:g('--dot-lyso')};};

  // ---- kinds of cell -----------------------------------------------------------------
  // share: relative target area. round: how rounded its corners are. nuc: nucleus
  // radius as a fraction of the cell's inner radius (0 = drawn specially).
  const KIND={
    cell:{share:1,round:2.4,nuc:.5,stain:1},
    goblet:{share:1.3,round:3,nuc:0,stain:.9},
    ciliated:{share:1.05,round:2.4,nuc:.5,stain:.95},
    endocrine:{share:.55,round:2.6,nuc:.55,stain:1},
    eosinophil:{share:.5,round:5,nuc:0,stain:.35},
    plasma:{share:.62,round:4,nuc:0,stain:1.35},
    fat:{share:3.2,round:4,nuc:0,stain:1},
    neuron:{share:1.15,round:3,nuc:.5,stain:1.1},
    dendritic:{share:.5,round:3,nuc:.55,stain:.55},
    macrophage:{share:2.3,round:4,nuc:.42,stain:1},
    lymphocyte:{share:.3,round:6,nuc:.82,stain:.8,roam:7},
    neutrophil:{share:.62,round:6,nuc:0,stain:.7,roam:11}
    ,mast:{share:.7,round:4,nuc:.4,stain:.55},
    osteoclast:{share:4.2,round:4,nuc:0,stain:1.1}
  };

  // ---- kinds of tissue -----------------------------------------------------------------
  // Each visit grows one tissue. A recipe lists [kind, share of the cells, at least this
  // many, how far to keep from the text, how far from its own kind] (the last two in
  // cell widths). Large cells come first so they find room.
  const TISSUES={
    airway:{name:'airway lining',mix:[['macrophage',.006,1,1.2,7],['neuron',.006,1,1.6,7],['dendritic',.014,1,1,4],['mast',.016,2,.5,3],['ciliated',.2],['goblet',.09],['endocrine',.02],['plasma',.02,2],['lymphocyte',.022,3,.6,2],['neutrophil',.008,1,.6,2]]},
    gut:{name:'gut lining',mix:[['macrophage',.008,1,1.2,7],['neuron',.005,1,1.6,7],['dendritic',.014,1,1,4],['mast',.012,1,.5,3],['goblet',.17],['endocrine',.05],['eosinophil',.03,2],['plasma',.04,2],['lymphocyte',.035,3,.6,2],['neutrophil',.008,1,.6,2]]},
    fat:{name:'fat tissue',mix:[['fat',.2,4,.7,0],['macrophage',.012,1,1.2,5],['neuron',.004,1,1.6,7],['mast',.014,2,.5,3],['plasma',.01,1],['lymphocyte',.02,2,.6,2]]},
    nerve:{name:'nerve ganglion',mix:[['neuron',.045,4,.9,3],['macrophage',.005,1,1.2,7],['dendritic',.03,2,1,3],['mast',.008,1,.5,3],['lymphocyte',.012,2,.6,2]]},
    marrow:{name:'bone marrow',mix:[['osteoclast',.006,1,1.7,7],['fat',.035,2,1.3,3],['macrophage',.008,1,1.2,6],['mast',.01,1,.5,3],['eosinophil',.04,2],['plasma',.04,2],['lymphocyte',.05,3,.6,1.5],['neutrophil',.04,3,.6,1.5]]},
    inflamed:{name:'inflamed lining',mix:[['macrophage',.012,2,1.2,5],['dendritic',.02,1,1,4],['mast',.016,2,.5,3],['ciliated',.1],['goblet',.06],['eosinophil',.03,2],['plasma',.04,2],['lymphocyte',.07,4,.6,1.3],['neutrophil',.08,5,.6,1.3]]}
  };
  const NAMES=Object.keys(TISSUES);
  // A different tissue from last time, unless the address asks for one (?tissue=gut).
  let tissue=(()=>{
    const q=new URLSearchParams(location.search).get('tissue');if(TISSUES[q])return q;
    let seen=null;try{seen=localStorage.getItem('tissue');}catch(e){}
    const rest=NAMES.filter(n=>n!==seen),t=rest[Math.floor(Math.random()*rest.length)];
    try{localStorage.setItem('tissue',t);}catch(e){}return t;
  })();

  // ---- the text opening ----------------------------------------------------------------
  function measure(){
    const rows=[],sy=scrollY();
    for(const el of document.querySelectorAll('#text h1,#text h2,#text p:not(.portrait-wrap),#text li,#text .portrait,#text .socials a')){
      if(el.classList.contains('portrait')||el.matches('.post-list li')){const r=el.getBoundingClientRect();rows.push({l:r.left,r:r.right,t:r.top+sy,b:r.bottom+sy});continue;}
      const rg=document.createRange();rg.selectNodeContents(el);for(const r of rg.getClientRects())if(r.width>2)rows.push({l:r.left,r:r.right,t:r.top+sy,b:r.bottom+sy});}
    if(!rows.length||document.getElementById('text').classList.contains('hidden')){box=null;return;}
    const pad=size*(W<700?.16:.3);
    // The reading column fixes the side walls. Text length and card animations
    // may change the opening's height, but cannot move its left or right edge.
    const column=document.querySelector('#text .panel').getBoundingClientRect();
    box={l:column.left-pad-6,r:column.right+pad+6,t:Math.min(...rows.map(r=>r.t))-pad,b:Math.max(...rows.map(r=>r.b))+pad,c:size*.22};
  }
  // Nearest point of the rounded opening to (x,y), the outward direction there, and the distance.
  const NEAR={x:0,y:0,nx:0,ny:0,d:0};
  function nearBox(x,y){
    const b=box,qx=clamp(x,b.l+b.c,b.r-b.c),qy=clamp(y,b.t+b.c,b.b-b.c);let dx=x-qx,dy=y-qy,d=Math.hypot(dx,dy);
    if(d<1e-6){const m=Math.min(x-b.l,b.r-x,y-b.t,b.b-y);if(m===x-b.l){dx=-1;dy=0;}else if(m===b.r-x){dx=1;dy=0;}else if(m===y-b.t){dx=0;dy=-1;}else{dx=0;dy=1;}
      NEAR.nx=dx;NEAR.ny=dy;NEAR.d=-m;NEAR.x=x+dx*m;NEAR.y=y+dy*m;return NEAR;}
    dx/=d;dy/=d;NEAR.nx=dx;NEAR.ny=dy;NEAR.x=qx+dx*b.c;NEAR.y=qy+dy*b.c;NEAR.d=d-b.c;return NEAR;
  }

  // ---- the capillary --------------------------------------------------------------------
  // A gently winding channel through the tissue, down one side of the text (or under it
  // on a narrow screen). It is a curve q=f(t): t runs along the page, q across it.
  let cap=null,dirty=true;const NC={x:0,y:0,nx:0,ny:0,d:0};
  const capF=t=>cap.c+cap.A*Math.sin(t*cap.k+cap.ph)+cap.A2*Math.sin(t*cap.k2+cap.ph2);
  const capD=t=>cap.A*cap.k*Math.cos(t*cap.k+cap.ph)+cap.A2*cap.k2*Math.cos(t*cap.k2+cap.ph2);
  // Nearest point of the channel wall to (x,y), the direction away from the channel, and the distance.
  function nearCap(x,y){
    const t=cap.v?y:x,u=(cap.v?x:y)-capF(t),s=capD(t),inv=1/Math.sqrt(1+s*s),sg=u<0?-1:1,nq=sg*inv,nt=-sg*s*inv,d=Math.abs(u)*inv-cap.hwc;
    if(cap.v){NC.nx=nq;NC.ny=nt;}else{NC.nx=nt;NC.ny=nq;}NC.d=d;NC.x=x-NC.nx*d;NC.y=y-NC.ny*d;return NC;
  }
  function planCap(){
    if(!box)return null;
    const hw=size*.21,need=size*1.9,sides=[];
    if(box.l>=need)sides.push([true,box.l/2,box.l]);if(W-box.r>=need)sides.push([true,(box.r+W)/2,W-box.r]);
    if(!sides.length){if(DH-box.b>=size*1.5)sides.push([false,(box.b+DH)/2,DH-box.b]);else if(box.t>=size*1.5)sides.push([false,box.t/2,box.t]);}
    if(!sides.length)return null;
    const [v,c,room]=sides[Math.floor(Math.random()*sides.length)],amp=clamp(room/2-hw-size*.3,0,size*.5),e=size*2,t0=-e,t1=(v?DH:W)+e,L=t1-t0,k=TAU/(size*8);
    const rbc=[];for(let s=0;s<L;){const r=hw*rand(.62,.72),n=Math.round(r*11),dots=new Float32Array(n*3);
      // Biconcave: most of the ink sits at the rim.
      for(let i=0;i<n;i++){const a=Math.random()*TAU,d=Math.random()<.62?1-Math.abs(randn())*.1:Math.pow(Math.random(),.4)*.92;dots[i*3]=Math.cos(a)*d;dots[i*3+1]=Math.sin(a)*d;dots[i*3+2]=rand(.55,.85);}
      const stack=Math.random()<.09?3+(Math.random()*3|0):1,lean=rand(-.3,.3);
      for(let q=0;q<stack;q++){rbc.push({s,r,off:stack>1?0:rand(-.1,.1)*hw,spin:rand(0,TAU),rate:rand(.5,1.3)*(Math.random()<.5?-1:1),tilt:rand(.1,.5),dots,stack:stack>1,lean});if(q+1<stack)s+=r*.62;}
      s+=r*(stack>1||Math.random()<.14?rand(5,9):rand(2.3,4.2));}
    return{v,c,A:amp*.6,A2:amp*.4,k,k2:k*.615,ph:rand(0,TAU),ph2:rand(0,TAU),hw,hwc:hw+size*.03,t0,t1,dir:Math.random()<.5?-1:1,speed:size*.42,flow:0,rbc};
  }
  // The vessel wall: a thin line each side, with the flat nuclei of the cells that form it.
  function wall(out){
    const L=cap.t1-cap.t0,put=(q,t,ink,sz)=>{out.push(cap.v?q:t,cap.v?t:q,0,0,0,20+ink,sz,0);};
    for(let i=0,m=Math.round(L*3.4);i<m;i++){const t=rand(cap.t0,cap.t1),s=capD(t),inv=1/Math.sqrt(1+s*s),sd=Math.random()<.5?-1:1,r=sd*(cap.hw-Math.abs(randn())*.55);put(capF(t)+r*inv,t-r*s*inv,0,rand(.45,.75));}
    let sd=1;for(let t=cap.t0+rand(0,size);t<cap.t1;t+=rand(1.7,3.1)*size,sd=-sd){const s=capD(t),inv=1/Math.sqrt(1+s*s),a=size*rand(.15,.2),b=cap.hw*.17;
      for(let i=0,m=Math.round(Math.PI*a*b*DENS*3.4);i<m;i++){const an=Math.random()*TAU,d=Math.sqrt(Math.random()),u=Math.cos(an)*d*a,w=sd*(cap.hw*1.02+Math.sin(an)*d*b);put(capF(t)+(u*s+w)*inv,t+(u-w*s)*inv,1,rand(.48,.72));}}
  }

  // ---- exact cell polygons ---------------------------------------------------------------
  const PX=new Float64Array(MAXV),PY=new Float64Array(MAXV),PL=new Int32Array(MAXV),QX=new Float64Array(MAXV),QY=new Float64Array(MAXV),QL=new Int32Array(MAXV);
  let pn=0;
  // Keep the part of the working polygon where nx*x+ny*y <= k; the new edge is labelled.
  function clip(nx,ny,k,label){
    let qn=0;
    for(let i=0;i<pn;i++){
      const j=i+1===pn?0:i+1,ax=PX[i],ay=PY[i],bx=PX[j],by=PY[j],da=nx*ax+ny*ay-k,db=nx*bx+ny*by-k;
      if(da<=0){if(qn<MAXV){QX[qn]=ax;QY[qn]=ay;QL[qn++]=PL[i];}
        if(db>0&&qn<MAXV){const t=da/(da-db);QX[qn]=ax+(bx-ax)*t;QY[qn]=ay+(by-ay)*t;QL[qn++]=label;}}
      else if(db<=0&&qn<MAXV){const t=da/(da-db);QX[qn]=ax+(bx-ax)*t;QY[qn]=ay+(by-ay)*t;QL[qn++]=PL[i];}
    }
    for(let i=0;i<qn;i++){PX[i]=QX[i];PY[i]=QY[i];PL[i]=QL[i];}pn=qn;
  }
  // A spatial grid of cell centres, rebuilt each step.
  let gw=1,gh=1,gs=1,grid=[];
  function fillGrid(){
    gs=size*1.1;gw=Math.ceil((W+size*4)/gs);gh=Math.ceil((DH+size*4)/gs);const n=gw*gh;
    if(grid.length!==n){grid=Array.from({length:n},()=>[]);}else for(let i=0;i<n;i++)grid[i].length=0;
    for(const c of cells){if(c.free)continue;const gx=clamp(Math.floor((c.x+size*2)/gs),0,gw-1),gy=clamp(Math.floor((c.y+size*2)/gs),0,gh-1);grid[gy*gw+gx].push(c);}
  }
  // Vertices where three cells meet, addressed by the three cells' numbers.
  const key3=(a,b,c)=>{let t;if(a>b){t=a;a=b;b=t;}if(b>c){t=b;b=c;c=t;}if(a>b){t=a;a=b;b=t;}return(a*4096+b)*4096+c;};
  let vmap=new Map(),VX=new Float64Array(8192),VY=new Float64Array(8192),VS=new Int32Array(8192),vcount=0;
  function vertexSlot(key){let i=vmap.get(key);if(i===undefined){if(vcount===VX.length){const g=a=>{const b=new a.constructor(a.length*2);b.set(a);return b;};VX=g(VX);VY=g(VY);VS=g(VS);}i=vcount++;vmap.set(key,i);}return i;}

  function polygon(c){
    const m=size*3.3,e=size*1.6;
    PX[0]=Math.max(c.x-m,-e);PY[0]=Math.max(c.y-m,-e);PX[1]=Math.min(c.x+m,W+e);PY[1]=PY[0];PX[2]=PX[1];PY[2]=Math.min(c.y+m,DH+e);PX[3]=PX[0];PY[3]=PY[2];
    PL[0]=PL[1]=PL[2]=PL[3]=-2;pn=4;
    const gx=clamp(Math.floor((c.x+size*2)/gs),0,gw-1),gy=clamp(Math.floor((c.y+size*2)/gs),0,gh-1),s2=c.x*c.x+c.y*c.y;
    for(let j=Math.max(0,gy-3);j<=Math.min(gh-1,gy+3);j++)for(let i=Math.max(0,gx-3);i<=Math.min(gw-1,gx+3);i++){
      const b=grid[j*gw+i];for(let q=0;q<b.length;q++){const o=b[q];if(o===c)continue;
        clip(o.x-c.x,o.y-c.y,(o.x*o.x+o.y*o.y-s2-o.w+c.w)*.5,o.id);if(pn<3)break;}}
    if(box&&pn>=3){const n=nearBox(c.x,c.y);if(n.d<size*4)clip(-n.nx,-n.ny,-(n.nx*n.x+n.ny*n.y),-1);}
    if(cap&&pn>=3){const n=nearCap(c.x,c.y);if(n.d<size*2)clip(-n.nx,-n.ny,-(n.nx*n.x+n.ny*n.y),-3);}
    c.n=pn<3?0:pn;c.stamp=frameNo;
    if(!c.n){c.area=0;return;}
    let A=0,cx=0,cy=0;
    for(let i=0;i<pn;i++){const j=i+1===pn?0:i+1,cr=PX[i]*PY[j]-PX[j]*PY[i];A+=cr;cx+=(PX[i]+PX[j])*cr;cy+=(PY[i]+PY[j])*cr;}
    if(Math.abs(A)<2){c.n=0;c.area=0;return;}
    c.area=Math.abs(A)*.5;c.cx=cx/(3*A);c.cy=cy/(3*A);
    for(let i=0;i<pn;i++){c.vx[i]=PX[i];c.vy[i]=PY[i];c.vl[i]=PL[i];const la=PL[i?i-1:pn-1],lb=PL[i];
      if(la>=0&&lb>=0&&la!==lb){const k=key3(c.id,la,lb),s=vertexSlot(k);c.vk[i]=k;VX[s]=PX[i];VY[s]=PY[i];VS[s]=frameNo;}else c.vk[i]=-1;}
  }
  // How far a shared border bows, as a fraction of its length. Positive bows toward the
  // higher-numbered cell; both neighbours read the same value, so they trace one curve.
  const bow=(i,j)=>{const a=i<j?i:j,b=i<j?j:i,h=hash(a*4099+b);return Math.abs(h)<.3?0:h*.075;};
  // Distance from the cell's middle to its border in each direction, corners rounded.
  const ET=new Float64Array(MAXV),EN=new Float64Array(MAXV*7);
  function outline(c){
    const n=c.n,cx=c.cx,cy=c.cy,R=c.R,K=c.K*size/80,gap=.8;
    for(let k=0;k<n;k++){const j=k+1===n?0:k+1,ax=c.vx[k],ay=c.vy[k],ex=c.vx[j]-ax,ey=c.vy[j]-ay,len=Math.hypot(ex,ey)||1e-6;let nx=ey/len,ny=-ex/len,h=nx*(ax-cx)+ny*(ay-cy);
      if(h<0){nx=-nx;ny=-ny;h=-h;}const o=c.vl[k],e=k*7;EN[e]=nx;EN[e+1]=ny;EN[e+2]=h;EN[e+3]=o>=0?bow(c.id,o)*(c.id<o?1:-1)*len:0;EN[e+4]=ex/(len*len);EN[e+5]=ey/(len*len);EN[e+6]=0;}
    let rin=1e9;
    for(let a=0;a<NA;a++){const ux=COS[a],uy=SIN[a];let tmin=1e9;
      for(let k=0;k<n;k++){const e=k*7,d=EN[e]*ux+EN[e+1]*uy;if(d<=1e-4){ET[k]=1e9;continue;}let t=EN[e+2]/d;
        if(EN[e+3]){const s=(cx+ux*t-c.vx[k])*EN[e+4]+(cy+uy*t-c.vy[k])*EN[e+5];if(s>0&&s<1)t+=EN[e+3]*Math.sin(Math.PI*s)/d;}
        ET[k]=t;if(t<tmin)tmin=t;}
      let sum=0;for(let k=0;k<n;k++)if(ET[k]<1e8)sum+=Math.exp(-(ET[k]-tmin)/K);
      const r=Math.max(1.5,tmin-K*Math.log(sum||1)-gap);R[a]=r;if(r<rin)rin=r;}
    R[NA]=R[0];c.rin=rin;
  }

  // ---- cells ------------------------------------------------------------------------------
  function makeCell(x,y,kind){
    const k=KIND[kind];
    return{id:0,kind,x,y,w:0,share0:k.share*(kind==='cell'?clamp(Math.exp(randn()*.28),.55,1.7):rand(.92,1.08)),mulE:1,K:k.round,K0:k.round,free:false,stamp:-1,n:0,
      vx:new Float64Array(MAXV),vy:new Float64Array(MAXV),vl:new Int32Array(MAXV),vk:new Float64Array(MAXV),cx:x,cy:y,area:0,rin:10,R:new Float32Array(NA+1).fill(10),refR:40,
      visB:1,visN:1,visE:1,mul:1,nucGrow:1,pushX:0,pushY:0,ph:rand(0,TAU),sp:rand(.25,.5),heading:rand(0,TAU),turn:0,ev:null,grow:null,
      nuc:{r:k.nuc*rand(.92,1.08),ox:0,oy:0,a:rand(0,TAU),ph:rand(0,TAU)},stain:kind==='cell'?rand(.8,1.2):k.stain};
  }

  // ---- each cell's dots, in its own coordinates ----------------------------------------------
  // Polar dots (types 0, 1, 4) are stored as a direction and a fraction of the way to
  // the border, so they follow the cell's shape. Round organelles (type 3) are stored
  // in units of the cell's inner radius, so they stay round and stay inside. Nucleus
  // dots (type 2) are in units of the nucleus radius.
  const DENS=.58,BUDGET=560000;
  function kit(c,out){
    const id=c.id,put=(A,B,C,D,type,ink,sz,E=0)=>{out.push(A,B,C,D,id,type*4+ink,sz,E);};
    const polar=(x,y,ink,sz,type=4)=>{const r=Math.hypot(x,y);if(r>.985)return;let t=Math.atan2(y,x)/TAU*NA;if(t<0)t+=NA;put(t,r,Math.random(),0,type,ink,sz);};
    const disc=(x,y,r,n,ink,fn,sz=[.45,.66])=>{for(let i=0;i<n;i++){const a=Math.random()*TAU,d=Math.sqrt(Math.random())*r;fn(x+Math.cos(a)*d,y+Math.sin(a)*d,ink,rand(sz[0],sz[1]));}};
    const organ=(x,y,ink,sz,ph=0,amp=0)=>put(x,y,ph,amp,3,ink,sz);
    const ref=c.refR,rinRef=ref/1.35*.8,kind=c.kind,n=c.nuc,dir=rand(0,TAU),dx=Math.cos(dir),dy=Math.sin(dir);
    // Shaded blue disc in inner-radius units: used for lobed and special nuclei.
    const lobe=(x,y,r,tone=1)=>{for(let i=0,m=Math.round(Math.PI*(r*rinRef)**2*DENS*3.2);i<m;i++){const a=Math.random()*TAU,d=Math.sqrt(Math.random());
      const t=(.14+.55*Math.pow(1-lit(Math.cos(a),Math.sin(a),Math.min(.99,d)),1.7)+.2*S((d-.8)/.2))*tone;if(Math.random()<accept(t))organ(x+Math.cos(a)*d*r,y+Math.sin(a)*d*r,1,rand(.48,.7));}};

    // Where the cytoplasm is left clear.
    let hole=null;
    if(n.r>0){const two=kind==='cell'&&Math.random()<.08;n.two=two;if(two)n.r*=.9;
      const lim=Math.max(0,.9-n.r),o=rand(0,Math.min(.16,lim));n.ox=dx*o;n.oy=dy*o;hole=(x,y)=>Math.hypot(x-n.ox,y-n.oy)<n.r*1.04;}
    if(kind==='goblet')hole=(x,y)=>Math.hypot(x-dx*.1,y-dy*.1)<.62||(Math.hypot(x,y)>.72&&Math.abs(gapA(Math.atan2(y,x),dir+Math.PI))<.6&&Math.hypot(x,y)<.92);
    if(kind==='plasma')hole=(x,y)=>Math.hypot(x-dx*.3,y-dy*.3)<.5||(Math.hypot(x+dx*.3,y+dy*.3)<.3&&Math.random()<.85);
    // An osteoclast has many nuclei, gathered toward its middle.
    let many=null;
    if(kind==='osteoclast'){many=[];const want=7+(Math.random()*4|0);for(let k=0;k<600&&many.length<want;k++){const a=Math.random()*TAU,d=Math.sqrt(Math.random())*.52,x=Math.cos(a)*d,y=Math.sin(a)*d;
        if(many.some(p=>Math.hypot(p[0]-x,p[1]-y)<.24))continue;many.push([x,y,rand(.09,.11)]);}
      for(let k=0;k<5;k++){const a=dir+Math.PI+rand(-1.9,1.9),d=rand(.6,.8);many.vac=(many.vac||[]).concat([[Math.cos(a)*d,Math.sin(a)*d,rand(.035,.055)]]);}
      hole=(x,y)=>many.some(p=>Math.hypot(p[0]-x,p[1]-y)<p[2]*1.05)||many.vac.some(p=>Math.hypot(p[0]-x,p[1]-y)<p[2]);}

    // Cytoplasm: a low dome lit from the upper left, darker toward the border.
    for(let i=0,m=Math.round(Math.PI*ref*ref*DENS);i<m;i++){
      const th=Math.random()*TAU,rho=Math.sqrt(Math.random())*.97,ca=Math.cos(th),sa=Math.sin(th);if(hole&&hole(ca*rho,sa*rho))continue;
      const tn=kind==='fat'?(rho>.92?.5:.012):(.02+.48*Math.pow(1-lit(ca,sa,rho),2.2)+.18*S((rho-.86)/.14))*c.stain;
      if(Math.random()<accept(tn))put(th/TAU*NA,rho,Math.random(),0,0,0,rand(.48,.84));}
    // Membrane.
    for(let i=0,m=Math.round(TAU*ref*1.1*2);i<m;i++)put(Math.random()*NA,1,Math.random(),0,1,0,rand(.45,.83),-Math.log(1-Math.random()*.999)*.8);

    // An ordinary nucleus: lumpy, sometimes kidney-shaped, sometimes two.
    if(n.r>0){
      const w2=rand(.04,.1),p2=rand(0,TAU),w3=rand(.02,.06),p3=rand(0,TAU),kid=(kind==='cell'&&Math.random()<.2)||kind==='macrophage'||kind==='dendritic'?rand(.14,.26):0,ka=rand(0,TAU),ecc=kind==='lymphocyte'?rand(.9,1):rand(.68,.95);
      const lump=th=>1+w2*Math.sin(2*th+p2)+w3*Math.sin(3*th+p3)-kid*Math.exp(-((gapA(th,ka)/.5)**2));
      const centres=n.two?[[-.5,0,.5],[.5,0,.5]]:[[0,0,1]],rp=n.r*rinRef;
      for(const [ox,oy,sc] of centres){
        for(let i=0,m=Math.round(Math.PI*rp*rp*sc*sc*ecc*DENS*1.4);i<m;i++){const th=Math.random()*TAU,rho=Math.sqrt(Math.random()),u=Math.cos(th)*rho,v=Math.sin(th)*rho,g=lump(th);
          const tn=.12+.55*Math.pow(1-lit(Math.cos(th),Math.sin(th),Math.min(.99,rho)),1.7)+.1*Math.max(0,Math.sin(u*9)*Math.sin(v*7));if(Math.random()<accept(tn))put(ox+u*g*sc,oy+v*g*sc*ecc,0,0,2,1,rand(.48,.84));}
        for(let i=0,m=Math.round(TAU*rp*sc*1.5);i<m;i++){const th=Math.random()*TAU,g=lump(th)*.98;put(ox+Math.cos(th)*g*sc,oy+Math.sin(th)*g*sc*ecc,0,0,2,1,rand(.45,.8));}}
      if(kind==='neuron')for(let i=0;i<26;i++){const a=Math.random()*TAU,d=Math.sqrt(Math.random())*.2;put(.12+Math.cos(a)*d,-.1+Math.sin(a)*d,0,0,2,1,rand(.5,.7));}
    }

    if(kind==='goblet'){
      // The mucus cup, foamy with droplets; the nucleus squashed into a crescent behind it.
      const ux=dx*.1,uy=dy*.1;
      for(let i=0,m=Math.round(TAU*.62*rinRef*2.2);i<m;i++){const a=Math.random()*TAU,r=.62-Math.abs(randn())*.012;polar(ux+Math.cos(a)*r,uy+Math.sin(a)*r,0,rand(.45,.65));}
      for(let k=0,m=Math.round((.62*rinRef)**2/20);k<m;k++){const a=Math.random()*TAU,d=Math.sqrt(Math.random())*.5,x=ux+Math.cos(a)*d,y=uy+Math.sin(a)*d,r=rand(2,3.6)/rinRef;
        for(let j=0;j<9;j++)if(Math.random()<.7){const b=j/9*TAU;polar(x+Math.cos(b)*r,y+Math.sin(b)*r,0,rand(.32,.45));}}
      for(let i=0,m=Math.round(rinRef*rinRef*.5);i<m;i++){const a=dir+Math.PI+rand(-.55,.55),t=Math.random(),r=.75+.15*t,edge=Math.min(1,(.55-Math.abs(gapA(a,dir+Math.PI)))/.2);
        if(Math.random()<.35+.6*Math.abs(t-.5)*2*edge+.3*(1-edge))polar(Math.cos(a)*r,Math.sin(a)*r,1,rand(.48,.7));}
    }
    if(kind==='endocrine')disc(-dx*.52,-dy*.52,.28,Math.round(rinRef*6),0,polar,[.48,.7]);
    if(kind==='eosinophil'){
      lobe(dx*.34,dy*.34,.3,1.5);lobe(-dx*.34,-dy*.34,.3,1.5);for(let j=0;j<22;j++){const t=j/21*2-1;organ(dx*.34*t+rand(-.02,.02),dy*.34*t+rand(-.02,.02),1,rand(.5,.66));}
      const placed=[];for(let k=0;k<9000&&placed.length<190;k++){const a=Math.random()*TAU,d=Math.sqrt(Math.random())*.9,x=Math.cos(a)*d,y=Math.sin(a)*d,r=rand(.046,.058);
        if(Math.hypot(x-dx*.3,y-dy*.3)<.36||Math.hypot(x+dx*.3,y+dy*.3)<.36)continue;if(placed.some(p=>Math.hypot(p[0]-x,p[1]-y)<p[2]+r+.012))continue;placed.push([x,y,r]);
        disc(x,y,r,Math.round((r*ref)**2*6),2,polar,[.45,.65]);}
    }
    if(kind==='plasma'){
      // Pale nucleus off to one side, chromatin clumped like the numbers on a clock face.
      const x=dx*.3,y=dy*.3;for(let i=0,m=Math.round((.5*rinRef)**2*.5);i<m;i++){const a=Math.random()*TAU,d=Math.sqrt(Math.random())*.48;organ(x+Math.cos(a)*d,y+Math.sin(a)*d,1,rand(.4,.55));}
      for(let i=0,m=Math.round(TAU*.5*rinRef*1.5);i<m;i++){const a=Math.random()*TAU;organ(x+Math.cos(a)*.49,y+Math.sin(a)*.49,1,rand(.45,.7));}
      for(let k=0;k<9;k++){const a=k/9*TAU;disc(x+Math.cos(a)*.33,y+Math.sin(a)*.33,.085,Math.round((.085*rinRef)**2*8),1,organ);}disc(x,y,.095,Math.round((.095*rinRef)**2*8),1,organ);
    }
    if(kind==='neutrophil'){
      const lobes=3+(Math.random()<.5?1:0),pts=[];for(let k=0;k<lobes;k++){const a=dir+(k-(lobes-1)/2)*1.25;pts.push([Math.cos(a)*.44,Math.sin(a)*.44]);}
      for(const [x,y] of pts)lobe(x,y,.28,1.4);
      for(let k=0;k+1<pts.length;k++)for(let j=0;j<12;j++){const t=j/11;organ(mix(pts[k][0],pts[k+1][0],t),mix(pts[k][1],pts[k+1][1],t),1,rand(.45,.6));}
      for(let i=0,m=Math.round(ref*ref*.35);i<m;i++){const a=Math.random()*TAU,d=Math.sqrt(Math.random())*.9;polar(Math.cos(a)*d,Math.sin(a)*d,0,rand(.3,.42));}
    }
    if(kind==='fat')for(let i=0,m=Math.round(ref*1.4);i<m;i++){const a=dir+rand(-.34,.34),t=Math.random(),edge=1-Math.abs(gapA(a,dir))/.34;
      if(Math.random()<.5+.5*edge)polar(Math.cos(a)*(.8+.12*t*edge),Math.sin(a)*(.8+.12*t*edge),1,rand(.48,.7));}
    if(kind==='macrophage'){c.lyso=[];for(let k=0;k<10;k++){const a=rand(0,TAU),d=rand(.52,.84),ph=rand(0,TAU);
      for(let i=0,m=Math.round((.075*rinRef)**2*7);i<m;i++){const b=Math.random()*TAU,e=Math.sqrt(Math.random())*.075;put(Math.cos(a)*d+Math.cos(b)*e,Math.sin(a)*d+Math.sin(b)*e,ph,.05,3,2,rand(.45,.8));}}}
    if(kind==='mast'){
      // Packed so full of dark granules that the nucleus barely shows through.
      const placed=[];for(let k=0;k<6000&&placed.length<330;k++){const a=Math.random()*TAU,d=Math.sqrt(Math.random())*.92,x=Math.cos(a)*d,y=Math.sin(a)*d,r=rand(.03,.041);
        if(Math.hypot(x-n.ox,y-n.oy)<n.r*.8&&Math.random()<.55)continue;if(placed.some(p=>Math.hypot(p[0]-x,p[1]-y)<p[2]+r+.007))continue;placed.push([x,y,r]);
        disc(x,y,r,Math.round((r*ref)**2*7),0,polar,[.5,.7]);}
    }
    if(kind==='osteoclast'){
      for(const [x,y,r] of many){
        for(let i=0,m=Math.round(Math.PI*(r*ref)**2*DENS*3);i<m;i++){const a=Math.random()*TAU,d=Math.sqrt(Math.random()),t=.14+.55*Math.pow(1-lit(Math.cos(a),Math.sin(a),Math.min(.99,d)),1.7)+.25*S((d-.8)/.2);
          if(Math.random()<accept(t))polar(x+Math.cos(a)*d*r,y+Math.sin(a)*d*r,1,rand(.48,.7));}}
      // Clear vacuoles, each a thin ring.
      for(const [x,y,r] of many.vac)for(let j=0,m=Math.round(TAU*r*ref*1.6);j<m;j++){const b=Math.random()*TAU,e=r-Math.abs(randn())*.004;polar(x+Math.cos(b)*e,y+Math.sin(b)*e,0,rand(.42,.6));}
      // The ruffled border, where it dissolves bone: a comb of short folds along one side.
      for(let a=dir-1.15;a<dir+1.15;a+=rand(.035,.055)){const len=rand(.07,.13)*S((1.15-Math.abs(a-dir))/.3),lean=rand(-.03,.03);
        for(let j=0,m=Math.round(len*ref*1.8);j<m;j++){const t=Math.random(),rho=.975-len*t;polar(Math.cos(a+lean*t)*rho,Math.sin(a+lean*t)*rho,0,rand(.5,.72));}}
    }
    // Cilia are redrawn each frame as they beat: store each one's root and character.
    if(kind==='ciliated'){const m=Math.round(Math.min(ref*ref*.05,190+ref)),s=c.cilia=new Float32Array(m*5);
      for(let i=0;i<m;i++){const a=Math.random()*TAU,d=Math.sqrt(Math.random())*.82;s[i*5]=((a/TAU*NA)%NA+NA)%NA;s[i*5+1]=d;s[i*5+2]=rand(-.3,.3);s[i*5+3]=rand(.22,.34);s[i*5+4]=rand(-.5,.5);}}
  }

  // ---- growing a tissue --------------------------------------------------------------------
  // The dots are made a few cells at a time between frames, so the page never freezes
  // while a tissue grows. `ready` is false until the last cell is done.
  let ready=false,buildNo=0;
  function build(done){
    size=Math.max(50,Math.min(W,H)/10);measure();cap=planCap();dirty=true;table=null;openingTransition=null;cells=[];pool=[];events=[];fading=[];procs=[];vmap=new Map();vcount=0;time=0;frameNo=0;beat=rand(0,TAU);nextEvent=2.5;lastEvent='ext';
    const near=(x,y,m)=>box&&x>box.l-m&&x<box.r+m&&y>box.t-m&&y<box.b+m;
    // Scatter cell centres, none too close together and none inside the text opening.
    const pts=[],gk=size*.8,g=new Map(),far=(x,y)=>{const gx=Math.floor(x/gk),gy=Math.floor(y/gk);for(let j=-1;j<=1;j++)for(let i=-1;i<=1;i++){const l=g.get((gx+i)+','+(gy+j));if(l)for(const p of l)if(Math.hypot(p.x-x,p.y-y)<gk)return false;}return true;};
    for(let tries=0,want=(W+2*size)*(DH+2*size)/(size*size)*.98;tries<90000&&pts.length<want;tries++){
      const x=rand(-size,W+size),y=rand(-size,DH+size);if(near(x,y,size*.2)||(cap&&nearCap(x,y).d<size*.15)||!far(x,y))continue;const p={x,y,kind:'cell'};pts.push(p);const k=Math.floor(x/gk)+','+Math.floor(y/gk);(g.get(k)||g.set(k,[]).get(k)).push(p);}
    // Specialised cells. Large and long-armed ones keep clear of the text and of each other.
    const shuffle=a=>{for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;};
    const onPage=p=>p.x>size*.4&&p.x<W-size*.4&&p.y>size*.4&&p.y<DH-size*.4,n=pts.filter(onPage).length;
    const take=(count,kind,clear=0,sep=0)=>{const got=[];for(const p of shuffle(pts.filter(p=>p.kind==='cell'&&onPage(p)&&!(clear&&near(p.x,p.y,size*clear))))){
      if(got.length>=count)break;if(sep&&pts.some(o=>o.kind===kind&&Math.hypot(o.x-p.x,o.y-p.y)<size*sep))continue;p.kind=kind;got.push(p);}};
    for(const [kind,frac,min=0,clear=0,sep=0] of TISSUES[tissue].mix){const count=Math.max(min,Math.round(n*frac));if(count)take(count,kind,clear,sep);}
    cells=pts.map(p=>makeCell(p.x,p.y,p.kind));
    // Spare ordinary cells, waiting off stage to become daughters.
    for(let i=0;i<10;i++){const c=makeCell(-1e5,-1e5,'cell');c.free=true;c.visB=0;cells.push(c);pool.push(c);}
    cells.forEach((c,i)=>{c.id=i;});baseCount=cells.length-pool.length;
    // Let the sheet settle: every cell reaches its size and finds its place.
    for(let i=0;i<46;i++)mechanics(.06,true);
    // Each cell gets enough dots for the largest it is likely to become.
    const unit=lam;for(const c of cells)c.refR=1.35*Math.sqrt(c.share0*unit/Math.PI);
    // A large screen would need over a million dots. Past a budget, a share is left out
    // at random and the rest drawn slightly larger, so the tone stays the same.
    const keep=Math.min(1,BUDGET/(.32*W*DH)),out={a:new Float32Array(1<<21),n:0,g:Math.pow(keep,-.4),
      push(x,y,c,d,e,f,s,h){if(keep<1&&Math.random()>keep)return;if(this.n+8>this.a.length){const b=new Float32Array(this.a.length*2);b.set(this.a);this.a=b;}
        const a=this.a,n=this.n;a[n]=x;a[n+1]=y;a[n+2]=c;a[n+3]=d;a[n+4]=e;a[n+5]=f;a[n+6]=s*this.g;a[n+7]=h;this.n=n+8;}};
    const job=++buildNo,list=cells;let i=0;ready=false;
    const step=()=>{
      if(job!==buildNo)return;
      try{
        const t=performance.now();while(i<list.length&&performance.now()-t<12)kit(list[i++],out);
        if(i<list.length){const ch=new MessageChannel();ch.port1.onmessage=step;ch.port2.postMessage(0);return;}
        if(cap)wall(out);const dots=out.a.slice(0,out.n);
        table=new Float32Array(TW*cells.length);for(const c of cells)row(c);
        route();ready=true;dyn();
        if(gpu)upload(dots);else still=dots;
        stillAt=-1;dirty=true;
      }catch(err){console.error(err);ready=true;}
      if(done)done();
    };
    step();
  }

  // ---- mechanics ------------------------------------------------------------------------------
  const active=[];
  function mechanics(dt,all){
    frameNo++;if(vcount>60000){vmap=new Map();vcount=0;}
    const top=scrollY()-size*3,bot=scrollY()+H+size*3,edge=size*.5;active.length=0;
    for(const c of cells){
      if(c.free||(!all&&(c.y<top||c.y>bot)))continue;active.push(c);
      const roam=KIND[c.kind].roam;
      if(roam&&!all){
        // Crawling: a wandering heading that turns away from the text and the page edge.
        c.turn+=(randn()*1.4-c.turn*.9)*dt;c.heading+=c.turn*dt;
        if(box){const n=nearBox(c.x,c.y);if(n.d<size*1.5)c.heading+=gapA(Math.atan2(n.ny,n.nx),c.heading)*Math.min(1,dt*3*(1.2-n.d/(size*1.5)));}
        if(cap){const n=nearCap(c.x,c.y);if(n.d<size*.8)c.heading+=gapA(Math.atan2(n.ny,n.nx),c.heading)*Math.min(1,dt*3*(1.2-n.d/(size*.8)));}
        if(c.x<edge||c.x>W-edge||c.y<edge||c.y>DH-edge)c.heading+=gapA(Math.atan2(clamp(c.y,edge,DH-edge)-c.y,clamp(c.x,edge,W-edge)-c.x),c.heading)*Math.min(1,dt*3);
        const v=roam*size/80;c.x+=Math.cos(c.heading)*v*dt+(c.cx-c.x)*.5*dt;c.y+=Math.sin(c.heading)*v*dt+(c.cy-c.y)*.5*dt;
      }else{
        // Everyone else settles toward the middle of their own region, with a little restlessness.
        const k=Math.min(1,1.6*dt),j=all?0:size*.035*dt;c.x+=(c.cx-c.x)*k+Math.cos(c.ph+time*.13)*j;c.y+=(c.cy-c.y)*k+Math.sin(c.ph*1.7+time*.11)*j;
      }
      if(box){const n=nearBox(c.x,c.y),m=size*.12;if(n.d<m){c.x+=n.nx*(m-n.d);c.y+=n.ny*(m-n.d);}}
      if(cap){const n=nearCap(c.x,c.y),m=size*.12;if(n.d<m){c.x+=n.nx*(m-n.d);c.y+=n.ny*(m-n.d);}}
    }
    fillGrid();
    let sa=0,ss=0;
    for(const c of active){
      polygon(c);if(c.n)outline(c);
      let base=c.share0;if(c.grow){c.grow.t+=dt;base=mix(c.grow.from,c.share0,S(c.grow.t/c.grow.dur));if(c.grow.t>=c.grow.dur)c.grow=null;}
      c.share=base*(all?1:1+.09*Math.sin(time*c.sp*.5+c.ph))*c.mulE;sa+=c.area;ss+=c.share;
    }
    // Cells share the available room in proportion to their target sizes.
    if(ss>0)lam=sa/ss;
    const gain=Math.min(.22,4*dt),lim=size*size*.03;
    for(const c of active)c.w+=clamp((c.share*lam-c.area)*gain,-lim,lim);
    if(table)for(const c of active)row(c);
  }
  // One cell's line in the table the graphics card reads.
  function row(c){
    const T=table,o=c.id*TW,n=c.nuc,rin=c.rin,nr=Math.min(n.r,.9)*rin*c.nucGrow;
    T[o]=c.free&&!c.fade||!c.n&&!c.fade?-1e5:c.cx;T[o+1]=c.cy;
    T[o+2]=n.ox*rin+Math.cos(time*.13+n.ph)*rin*.03+c.pushX;T[o+3]=n.oy*rin+Math.sin(time*.11+n.ph)*rin*.03+c.pushY;T[o+4]=n.a+.12*Math.sin(time*.07+n.ph);
    T[o+5]=nr;T[o+6]=rin;T[o+7]=c.refR;T[o+8]=c.visB;T[o+9]=c.visN;T[o+10]=c.visE*c.visB;T[o+11]=c.mul;T.set(c.R,o+HEAD);
  }

  // ---- events: division and extrusion --------------------------------------------------------
  function longAxis(c){let xx=0,yy=0,xy=0;for(let k=0;k<c.n;k++){const dx=c.vx[k]-c.cx,dy=c.vy[k]-c.cy;xx+=dx*dx;yy+=dy*dy;xy+=dx*dy;}return .5*Math.atan2(2*xy,xx-yy);}
  function startDivision(m){
    const a=longAxis(m),ch=[];for(let k=0;k<8;k++){const sa=rand(0,TAU),sd=Math.sqrt(Math.random())*.4,dots=[];
      for(let i=0;i<16;i++)dots.push(Math.random()*2-1,(Math.random()+Math.random()-1)*.9,rand(.5,.75));
      ch.push({v:(k-3.5)*.12+rand(-.02,.02),sx:Math.cos(sa)*sd,sy:Math.sin(sa)*sd,th:rand(0,Math.PI),len:rand(.1,.14),dots});}
    const ev={type:'div',m,t:0,dur:11,ax:Math.cos(a),ay:Math.sin(a),ch,split:0,d:null,cx:m.cx,cy:m.cy,rin:m.rin};m.ev=ev;events.push(ev);
  }
  function startExtrusion(c){
    const fr=[];for(let k=0;k<4;k++){const a=k/4*TAU+rand(-.4,.4),d=rand(.15,.32),dots=[];for(let i=0;i<22;i++){const b=Math.random()*TAU,e=Math.sqrt(Math.random());dots.push(Math.cos(b)*e,Math.sin(b)*e,rand(.5,.72));}
      fr.push({x:Math.cos(a)*d,y:Math.sin(a)*d,r:rand(.12,.17),ph:rand(0,TAU),dots});}
    const ev={type:'ext',c,t:0,dur:9,fr};c.ev=ev;events.push(ev);
  }
  function updateEvents(dt){
    for(let i=events.length-1;i>=0;i--){
      const ev=events[i];ev.t+=dt;const u=ev.t/ev.dur;
      if(ev.type==='div'){
        const m=ev.m;
        if(!ev.split){
          // Rounding up and swelling slightly; the nucleus dissolves as chromosomes condense.
          m.K=mix(m.K0,9,S(u/.3));m.mulE=1+.12*S(u/.4);m.visN=1-S((u-.05)/.2);ev.cx=m.cx;ev.cy=m.cy;ev.rin=m.rin;
          if(u>=.64&&pool.length>=2){
            // Cytokinesis: two daughters take the mother's place, side by side along her long axis.
            const sep=.3*Math.sqrt(m.area/Math.PI);ev.d=[pool.pop(),pool.pop()];ev.split=ev.t;
            ev.d.forEach((d,k)=>{const sg=k?1:-1;d.free=false;d.fade=false;d.x=d.cx=m.cx+ev.ax*sep*sg;d.y=d.cy=m.cy+ev.ay*sep*sg;d.w=m.w;d.grow={from:m.share*.5,t:0,dur:40};
              d.visB=0;d.visN=0;d.visE=1;d.mul=1;d.mulE=1;d.K=9;d.nucGrow=.5;d.ev=ev;d.area=m.area*.5;d.rin=m.rin*.6;});
            m.free=true;m.fade=true;m.ev=null;fading.push(m);
          }
        }else{
          const s=ev.t-ev.split,cx=(ev.d[0].cx+ev.d[1].cx)/2,cy=(ev.d[0].cy+ev.d[1].cy)/2;ev.cx=cx;ev.cy=cy;
          ev.d.forEach((d,k)=>{d.visB=S(s/.5);d.K=mix(9,d.K0,S((u-.66)/.3));d.visN=S((u-.74)/.16);d.nucGrow=mix(.5,1,S((u-.74)/.26));
            // Each new nucleus forms where its chromosomes arrived, then settles.
            const q=chromPos(ev,k?1:-1,u),hold=1-S((u-.8)/.2);d.pushX=(q.x-d.cx-d.nuc.ox*d.rin)*hold;d.pushY=(q.y-d.cy-d.nuc.oy*d.rin)*hold;});
          if(u>=1){for(const d of ev.d){d.ev=null;d.pushX=d.pushY=0;d.K=d.K0;d.visN=1;d.nucGrow=1;}events.splice(i,1);}
        }
      }else{
        // Extrusion: a crowded cell rounds up, condenses and is squeezed out as neighbours close in.
        const c=ev.c;c.mulE=mix(1,.02,S(u*1.05));c.K=mix(c.K0,8,S(u/.3));c.mul=1+.35*S(u/.5);c.visN=1-S((u-.22)/.2);
        if(u>=1||(u>.5&&c.area<size*size*.012)){c.free=true;c.fade=true;c.ev=null;fading.push(c);ev.gone=ev.t;events.splice(i,1);ghosts.push(ev);}
      }
    }
    // A cell that has left the sheet fades and returns to the spares.
    for(let i=fading.length-1;i>=0;i--){const c=fading[i];c.visB=Math.max(0,c.visB-dt/.45);row(c);
      if(c.visB<=0){c.fade=false;c.visN=1;c.visE=1;c.mul=1;c.mulE=1;c.K=c.K0;c.nucGrow=1;c.pushX=c.pushY=0;c.grow=null;row(c);pool.push(c);fading.splice(i,1);}}
    for(let i=ghosts.length-1;i>=0;i--){ghosts[i].t+=dt;if(ghosts[i].t-ghosts[i].gone>.5)ghosts.splice(i,1);}
    // Births and deaths in balance, among the ordinary cells in view.
    nextEvent-=dt;
    if(nextEvent<=0){
      nextEvent=rand(7,11);const top=scrollY(),live=cells.length-pool.length-fading.length;
      const ok=c=>c.kind==='cell'&&!c.free&&!c.ev&&!c.grow&&c.n&&c.cx>size*.3&&c.cx<W-size*.3&&c.cy>top+size*.3&&c.cy<top+H-size*.3&&events.every(e=>Math.hypot((e.cx??e.c.cx)-c.cx,(e.cy??e.c.cy)-c.cy)>size*2.6);
      const cand=cells.filter(ok);if(cand.length>4){const few=Array.from({length:6},()=>cand[Math.floor(Math.random()*cand.length)]);
        const div=pool.length>=2&&live<=baseCount+3&&(lastEvent==='ext'||live<baseCount-3);
        if(div){startDivision(few.reduce((a,b)=>b.area>a.area?b:a));lastEvent='div';}else if(live>baseCount-5){startExtrusion(few.reduce((a,b)=>b.area/b.share0<a.area/a.share0?b:a));lastEvent='ext';}}
    }
  }
  const ghosts=[];
  // Where one set of chromosomes is: at the plate, then drawn toward its daughter.
  const CP={x:0,y:0};
  function chromPos(ev,sg,u){
    let sep=S((u-.5)/.16)*.34*ev.rin;
    if(ev.split){const d=ev.d[sg>0?1:0],far=Math.hypot(d.cx+d.nuc.ox*d.rin-ev.cx,d.cy+d.nuc.oy*d.rin-ev.cy);sep=mix(sep,far,S((u-.66)/.16));}
    CP.x=ev.cx+ev.ax*sep*sg;CP.y=ev.cy+ev.ay*sep*sg;return CP;
  }

  // ---- drawn afresh each frame: cilia, chromosomes, fragments, fibres -----------------------
  const DYN=new Float32Array(DYN_MAX*STRIDE);let dynCount=0,still=null,tick=0;
  const dot=(x,y,sz,ink)=>{if(dynCount>=DYN_MAX||sz<.05)return;const o=dynCount++*STRIDE;DYN[o]=x;DYN[o+1]=y;DYN[o+5]=20+ink;DYN[o+6]=sz;};
  const look=(c,t)=>{const k=t|0;return c.R[k]+(c.R[k+1]-c.R[k])*(t-k);};
  function dyn(){
    dynCount=0;const near=tick>0?H*.25:1e9,top=Math.max(CT,scrollY()-near)-size,bot=Math.min(CT+CH,scrollY()+H+near)+size,cb=Math.cos(beat),sb=Math.sin(beat);
    // Red blood cells, single file, tumbling like coins and surging with each heartbeat.
    if(cap){const L=cap.t1-cap.t0,p=Math.sin(time*5.4);cap.flow+=tick*cap.speed*(.7+.8*(p>0?p*p*p:0));
      for(const b of cap.rbc){const t=cap.t0+(((b.s+cap.dir*cap.flow)%L)+L)%L,s=capD(t),q=capF(t)+b.off,x=cap.v?q:t,y=cap.v?t:q;if(y<top||y>bot||x<-size||x>W+size)continue;
        const th=(cap.v?Math.atan2(1,s):Math.atan2(s,1))+(b.stack?Math.PI/2+b.lean:b.tilt*Math.sin(time*.7+b.spin)),cs=Math.cos(th),sn=Math.sin(th),sq=b.stack?.26:.34+.66*Math.abs(Math.cos(b.spin+time*b.rate)),d=b.dots;
        for(let i=0;i<d.length;i+=3){const u=d[i]*b.r,w=d[i+1]*b.r*sq;dot(x+u*cs-w*sn,y+u*sn+w*cs,d[i+2],2);}}}
    for(const c of cells){
      if(c.free||!c.n||c.cy<top||c.cy>bot)continue;
      // Cilia beat in a wave that travels across the whole sheet in one direction.
      if(c.cilia){const s=c.cilia,rin=c.rin;
        for(let i=0;i<s.length;i+=5){const t=s[i],k=t|0,r=look(c,t)*s[i+1]*.92,a=t/NA*TAU,x=c.cx+Math.cos(a)*r,y=c.cy+Math.sin(a)*r,p=time*3.1-(x*cb+y*sb)*.04,
            sw=Math.sin(p)+.3*Math.sin(2*p),ang=beat+s[i+2]+.6*sw,len=s[i+3]*rin*(.78+.22*Math.cos(p));
          for(let j=0;j<=7;j++){const u=j/7,th=ang+s[i+4]*u;dot(x+Math.cos(th)*len*u,y+Math.sin(th)*len*u,.6-.14*u,0);}}}
    }
    for(const ev of events){
      const u=ev.t/ev.dur;
      if(ev.type==='div'){
        // Chromosomes condense, gather at the plate, then part toward the two daughters.
        const show=S((u-.05)/.15)*(1-S((u-.78)/.17)),plate=S((u-.24)/.2),px=-ev.ay,py=ev.ax,rin=ev.rin;if(show<=0)continue;
        for(const sg of [-1,1]){const q=chromPos(ev,sg,u),qx=q.x,qy=q.y;
          for(const ch of ev.ch){const x0=qx+mix(ch.sx*rin,px*ch.v*rin,plate),y0=qy+mix(ch.sy*rin,py*ch.v*rin,plate),th=mix(ch.th,Math.atan2(py,px)+(ch.v>0?.5:-.5)*sg,S((u-.5)/.1)),tx=Math.cos(th),ty=Math.sin(th),len=ch.len*rin;
            for(let i=0;i<ch.dots.length;i+=3){const a=ch.dots[i]*len,b=ch.dots[i+1];dot(x0+a*tx-b*ty,y0+a*ty+b*tx,ch.dots[i+2]*show,1);}}}
      }else frags(ev,S((u-.2)/.2));
    }
    for(const ev of ghosts)frags(ev,1-S((ev.t-ev.gone)/.5));
    for(const p of procs)fibre(p);
  }
  // A dying cell's nucleus, broken into dense fragments.
  function frags(ev,show){const c=ev.c,rin=Math.max(c.rin,3);if(show<=0)return;
    for(const f of ev.fr){const x=c.cx+f.x*rin+Math.cos(ev.t*.9+f.ph)*rin*.03,y=c.cy+f.y*rin+Math.sin(ev.t*.8+f.ph)*rin*.03,r=Math.max(1.6,f.r*rin);
      for(let i=0;i<f.dots.length;i+=3)dot(x+f.dots[i]*r,y+f.dots[i+1]*r,f.dots[i+2]*show,1);}}

  // ---- fibres that run between cells -----------------------------------------------------------
  // A nerve or dendritic process is a chain of the points where three cells meet. It is
  // redrawn from wherever those points now are, so it stays between the cells as they move.
  const decode=k=>[Math.floor(k/16777216),Math.floor(k/4096)%4096,k%4096];
  function around(key){const out=[];for(const id of decode(key)){const c=cells[id];if(!c||c.free||!c.n)continue;
    for(let k=0;k<c.n;k++)if(c.vk[k]===key){const p=c.vk[k?k-1:c.n-1],q=c.vk[k+1===c.n?0:k+1];if(p>=0&&!out.includes(p))out.push(p);if(q>=0&&!out.includes(q))out.push(q);break;}}return out;}
  function alive(key){const i=vmap.get(key);if(i===undefined)return false;if(VS[i]===frameNo)return true;const d=decode(key);return d.every(id=>cells[id]&&!cells[id].free&&cells[id].stamp!==frameNo);}
  function walk(start,ang,steps,used,soma){
    const path=[start];let cur=start;
    for(let s=0;s<steps;s++){const i=vmap.get(cur),x=VX[i],y=VY[i];let best=-1,bs=-.7;
      for(const nb of around(cur)){if(path.includes(nb)||used.has(nb)||decode(nb).includes(soma.id))continue;const j=vmap.get(nb);if(j===undefined)continue;const nx=VX[j],ny=VY[j];
        if(nx<4||nx>W-4||ny<4||ny>DH-4||(box&&nearBox(nx,ny).d<size*.3)||(cap&&nearCap(nx,ny).d<size*.15))continue;
        const d=Math.hypot(nx-x,ny-y)||1,sc=((nx-x)*Math.cos(ang)+(ny-y)*Math.sin(ang))/d+rand(0,.45);if(sc>bs){bs=sc;best=nb;}}
      if(best<0)break;path.push(best);cur=best;ang+=rand(-.4,.4);}
    return path;
  }
  function addFibre(soma,start,ang,steps,width,dens,used,taper=.65){
    const keys=walk(start,ang,steps,used,soma);if(keys.length<2)return null;for(let i=1;i<keys.length;i++)used.add(keys[i]);
    const len=(steps+1)*size*.62,n=Math.round(len*dens),ss=Float32Array.from({length:n},()=>Math.random()).sort(),dots=new Float32Array(n*3);
    for(let i=0;i<n;i++){dots[i*3]=ss[i];dots[i*3+1]=(Math.random()-.5)*width*(1-taper*ss[i]);dots[i*3+2]=rand(.55,.8);}
    const p={soma,keys,dots,ang,steps,len,wait:rand(0,1)};procs.push(p);return p;
  }
  function route(){
    procs=[];const used=new Set();
    for(const c of cells){
      if(c.free||!c.n||(c.kind!=='neuron'&&c.kind!=='dendritic'))continue;
      const vs=[];for(let k=0;k<c.n;k++)if(c.vk[k]>=0)vs.push({key:c.vk[k],a:Math.atan2(c.vy[k]-c.cy,c.vx[k]-c.cx)});if(!vs.length)continue;
      let away=box?Math.atan2(c.cy-(box.t+box.b)/2,c.cx-(box.l+box.r)/2):rand(0,TAU);if(c.cx<size*3||c.cx>W-size*3)away=c.cy<DH/2?Math.PI/2:-Math.PI/2;const pick=a=>vs.reduce((p,q)=>Math.abs(gapA(q.a,a))<Math.abs(gapA(p.a,a))?q:p);
      if(c.kind==='neuron'){
        // One long axon, and a few shorter dendrites that branch.
        const ax=pick(away);addFibre(c,ax.key,away,rand(13,18)|0,4,3.4,used);
        for(const v of vs){if(v===ax)continue;const d=addFibre(c,v.key,v.a,rand(4,7)|0,9.5*size/80,6,used,.86);
          if(d&&d.keys.length>3)addFibre(c,d.keys[2],v.a+(Math.random()<.5?1:-1)*rand(.7,1.1),3,4.5*size/80,4,used,.8);}
      }else for(const v of vs)addFibre(c,v.key,v.a,rand(2,4)|0,3.4,3.2,used);
    }
  }
  // If the cells along a fibre have rearranged, find it a new way through.
  function mend(p){
    const k=p.keys;let a=-1;for(let i=0;i<k.length;i++)if(!alive(k[i])){a=i;break;}if(a<0)return k.length>1;
    let b=a;while(b+1<k.length&&!alive(k[b+1]))b++;
    if(a===0){const c=p.soma;let best=-1,bd=1e9;const old=vmap.get(k[0]),ox=old===undefined?c.cx:VX[old],oy=old===undefined?c.cy:VY[old];
      for(let i=0;i<c.n;i++)if(c.vk[i]>=0){const d=Math.hypot(c.vx[i]-ox,c.vy[i]-oy);if(d<bd){bd=d;best=c.vk[i];}}
      if(best<0)return false;const rest=k.slice(b+1),link=rest.length?bridge(best,rest[0],rest):null;p.keys=link?link.concat(rest.slice(1)):walk(best,p.ang,p.steps,new Set(),c);return p.keys.length>1;}
    if(b===k.length-1){k.length=a;return k.length>1;}
    const link=bridge(k[a-1],k[b+1],k);if(link){k.splice(a,b-a+1,...link.slice(1,-1));return true;}k.length=a;return k.length>1;
  }
  function bridge(from,to,avoid){
    let front=[[from]];const seen=new Set([from]);
    for(let depth=0;depth<6&&front.length;depth++){const next=[];
      for(const path of front)for(const nb of around(path[path.length-1])){if(nb===to)return path.concat([nb]);if(seen.has(nb)||avoid.includes(nb))continue;seen.add(nb);next.push(path.concat([nb]));}
      front=next;}
    return null;
  }
  const FX=new Float64Array(64),FY=new Float64Array(64),FL=new Float64Array(64),FB=new Float64Array(64),FNX=new Float64Array(64),FNY=new Float64Array(64);
  function fibre(p){
    const top=CT-size*2,bot=CT+CH+size*2;if(!p.soma.n||(p.soma.cy<top-size*8||p.soma.cy>bot+size*8))return;
    mend(p);const k=p.keys;p.wait-=tick;if(k.length>p.steps+3)k.length=p.steps+1;
    if(k.length&&k.length<=p.steps&&p.wait<=0){p.wait=rand(.5,1.1);const tip=vmap.get(k[k.length-1]),prev=k.length>1?vmap.get(k[k.length-2]):undefined;
      if(tip!==undefined&&alive(k[k.length-1])){const ang=prev===undefined?p.ang:Math.atan2(VY[tip]-VY[prev],VX[tip]-VX[prev])*.6+p.ang*.4,ext=walk(k[k.length-1],ang,1,new Set(k),p.soma);if(ext.length>1)k.push(ext[1]);}}
    if(k.length<2)return;const n=Math.min(k.length,64);let total=0;
    for(let i=0;i<n;i++){const s=vmap.get(k[i]);FX[i]=VX[s];FY[i]=VY[s];
      if(i){const dx=FX[i]-FX[i-1],dy=FY[i]-FY[i-1],len=Math.hypot(dx,dy)||1e-6;total+=len;FL[i]=total;
        // Follow the same bow as the border between the two cells this stretch runs between.
        const A=decode(k[i-1]),B=decode(k[i]),sh=A.filter(id=>B.includes(id));let nx=-dy/len,ny=dx/len,amp=0;
        if(sh.length===2){const lo=cells[Math.min(sh[0],sh[1])],hi=cells[Math.max(sh[0],sh[1])];if((hi.x-lo.x)*nx+(hi.y-lo.y)*ny<0){nx=-nx;ny=-ny;}amp=bow(sh[0],sh[1])*len;}
        FNX[i]=nx;FNY[i]=ny;FB[i]=amp;}}
    FL[0]=0;if(total<2)return;let seg=1;const d=p.dots;
    for(let i=0;i<d.length;i+=3){const at=d[i]*p.len;if(at>total)break;while(seg<n-1&&FL[seg]<at)seg++;const l0=FL[seg-1],t=(at-l0)/((FL[seg]-l0)||1),off=FB[seg]*Math.sin(Math.PI*t)+d[i+1];
      const y=mix(FY[seg-1],FY[seg],t)+FNY[seg]*off;if(y<top||y>bot)continue;dot(mix(FX[seg-1],FX[seg],t)+FNX[seg]*off,y,d[i+2],0);}
  }

  // ---- drawing on the graphics card ---------------------------------------------------------
  const VS_SRC=`#version 300 es
  precision highp float;
  in vec4 a0;in vec4 a1;
  uniform highp sampler2D cells;uniform vec2 view;uniform float dpr,time,scroll,shift;
  flat out int ink;
  float cell(int j,int c){return texelFetch(cells,ivec2(j,c),0).r;}
  void main(){
    int c=int(a1.x+.5),ti=int(a1.y+.5),type=ti/4;ink=ti-type*4;float size=a1.z,vis=1.;vec2 p;
    if(type==5)p=a0.xy;
    else{
      vec2 o=vec2(cell(0,c),cell(1,c));float rin=cell(6,c);
      if(type<=1||type==4){
        float t=a0.x,k=floor(t);int i=int(k);float r0=cell(${HEAD}+i,c),r1=cell(${HEAD+1}+i,c),r=mix(r0,r1,t-k),an=t*${(TAU/NA).toFixed(8)},ref=cell(7,c);vec2 u=vec2(cos(an),sin(an));
        // Thin the dots so density stays even: by area for the cytoplasm, by length for the membrane.
        if(type==0){p=o+u*(a0.y*r);vis=clamp((r*r/(ref*ref)-a0.z)*18.,0.,1.)*cell(8,c);}
        else if(type==1){float dr=(r1-r0)*${(NA/TAU).toFixed(8)};p=o+u*(r-a1.w);vis=clamp((sqrt(r*r+dr*dr)/(ref*1.1)-a0.z)*18.,0.,1.)*cell(8,c);}
        else{p=o+u*(a0.y*r);vis=cell(10,c);}
      }else if(type==2){
        float an=cell(4,c),cs=cos(an),sn=sin(an);p=o+vec2(cell(2,c),cell(3,c))+vec2(a0.x*cs-a0.y*sn,a0.x*sn+a0.y*cs)*cell(5,c);vis=cell(9,c)*cell(8,c);
      }else{p=o+a0.xy*rin+a0.w*rin*vec2(sin(time*.6+a0.z),cos(time*.5+a0.z*1.3));vis=cell(10,c);}
      size*=cell(11,c);
    }
    if(vis<.02)p=vec2(-9999.);
    gl_Position=vec4((p.x+shift)/view.x*2.-1.,1.-(p.y-scroll)/view.y*2.,0,1);gl_PointSize=max(1.,size*vis*1.8*dpr);
  }`;
  const FS_SRC=`#version 300 es
  precision mediump float;flat in int ink;uniform vec3 inks[3];out vec4 color;
  void main(){vec2 d=gl_PointCoord-.5;if(dot(d,d)>.26)discard;color=vec4(inks[ink],1);}`;
  const hex=c=>{const m=c.replace('#',''),v=m.length===3?m.split('').map(x=>x+x).join(''):m;return[0,2,4].map(i=>parseInt(v.slice(i,i+2),16)/255);};
  function setupGPU(){
    const sh=(type,src)=>{const s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;};
    const pr=gl.createProgram();gl.attachShader(pr,sh(gl.VERTEX_SHADER,VS_SRC));gl.attachShader(pr,sh(gl.FRAGMENT_SHADER,FS_SRC));gl.linkProgram(pr);
    if(!gl.getProgramParameter(pr,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(pr));
    const u=n=>gl.getUniformLocation(pr,n),loc=['a0','a1'].map(n=>gl.getAttribLocation(pr,n));
    const vao=()=>{const v=gl.createVertexArray(),b=gl.createBuffer();gl.bindVertexArray(v);gl.bindBuffer(gl.ARRAY_BUFFER,b);
      loc.forEach((l,i)=>{gl.enableVertexAttribArray(l);gl.vertexAttribPointer(l,4,gl.FLOAT,false,STRIDE*4,i*16);});return{v,b};};
    gpu={pr,cells:vao(),dyn:vao(),tex:gl.createTexture(),count:0,u:{cells:u('cells'),view:u('view'),dpr:u('dpr'),time:u('time'),scroll:u('scroll'),shift:u('shift'),inks:u('inks')}};
    gl.bindBuffer(gl.ARRAY_BUFFER,gpu.dyn.b);gl.bufferData(gl.ARRAY_BUFFER,DYN.byteLength,gl.DYNAMIC_DRAW);
    gl.bindTexture(gl.TEXTURE_2D,gpu.tex);for(const k of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,k,gl.NEAREST);
  }
  function upload(data){gl.bindVertexArray(gpu.cells.v);gl.bindBuffer(gl.ARRAY_BUFFER,gpu.cells.b);gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);gpu.count=data.length/STRIDE;}
  function draw(){
    if(!gpu){drawStill();return;}
    gl.viewport(0,0,canvas.width,canvas.height);const p=hex(colors.paper);gl.clearColor(p[0],p[1],p[2],1);gl.clear(gl.COLOR_BUFFER_BIT);gl.useProgram(gpu.pr);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,gpu.tex);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);gl.texImage2D(gl.TEXTURE_2D,0,gl.R32F,TW,cells.length,0,gl.RED,gl.FLOAT,table);
    gl.uniform1i(gpu.u.cells,0);gl.uniform2f(gpu.u.view,W,CH);gl.uniform1f(gpu.u.dpr,dpr);gl.uniform1f(gpu.u.time,time);gl.uniform1f(gpu.u.scroll,CT);gl.uniform1f(gpu.u.shift,shiftX);
    gl.uniform3fv(gpu.u.inks,new Float32Array([...hex(colors.ink),...hex(colors.dna),...hex(colors.lyso)]));
    gl.bindVertexArray(gpu.cells.v);gl.drawArrays(gl.POINTS,0,gpu.count);
    if(dynCount){gl.bindVertexArray(gpu.dyn.v);gl.bindBuffer(gl.ARRAY_BUFFER,gpu.dyn.b);gl.bufferSubData(gl.ARRAY_BUFFER,0,DYN,0,dynCount*STRIDE);gl.drawArrays(gl.POINTS,0,dynCount);}
  }
  // Without WebGL2: the same dots placed by the same rules, drawn once as a still image.
  let ctx=null,stillAt=-1;
  function drawStill(){
    if(!ctx){ctx=canvas.getContext('2d');if(!ctx){const fresh=canvas.cloneNode();canvas.replaceWith(fresh);canvas=fresh;ctx=canvas.getContext('2d');}}
    const sy=CT;if(Math.abs(sy-stillAt)<1&&stillAt>=0)return;stillAt=sy;
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle=colors.paper;ctx.fillRect(0,0,W,CH);const P=[new Path2D(),new Path2D(),new Path2D()],T=table;
    const pass=(D,n)=>{for(let i=0;i<n;i++){const o=i*STRIDE,ti=D[o+5]|0,type=ti>>2,ink=ti&3,r=c=>c*TW;let x,y,vis=1,sz=D[o+6];
      if(type===5){x=D[o];y=D[o+1];}else{const c=r(D[o+4]|0),ox=T[c],oy=T[c+1];if(ox<-1e4||oy<sy-200||oy>sy+CH+200)continue;const rin=T[c+6];
        if(type<=1||type===4){const t=D[o],k=t|0,r0=T[c+HEAD+k],r1=T[c+HEAD+k+1],rr=r0+(r1-r0)*(t-k),an=t/NA*TAU,ref=T[c+7];
          if(type===0){vis=clamp((rr*rr/(ref*ref)-D[o+2])*18,0,1)*T[c+8];x=ox+Math.cos(an)*D[o+1]*rr;y=oy+Math.sin(an)*D[o+1]*rr;}
          else if(type===1){const dr=(r1-r0)*NA/TAU;vis=clamp((Math.sqrt(rr*rr+dr*dr)/(ref*1.1)-D[o+2])*18,0,1)*T[c+8];x=ox+Math.cos(an)*(rr-D[o+7]);y=oy+Math.sin(an)*(rr-D[o+7]);}
          else{vis=T[c+10];x=ox+Math.cos(an)*D[o+1]*rr;y=oy+Math.sin(an)*D[o+1]*rr;}}
        else if(type===2){const an=T[c+4],cs=Math.cos(an),sn=Math.sin(an),s=T[c+5];x=ox+T[c+2]+(D[o]*cs-D[o+1]*sn)*s;y=oy+T[c+3]+(D[o]*sn+D[o+1]*cs)*s;vis=T[c+9]*T[c+8];}
        else{x=ox+D[o]*rin;y=oy+D[o+1]*rin;vis=T[c+10];}
        sz*=T[c+11];}
      if(vis<.02)continue;y-=sy;x+=shiftX;if(y<-3||y>CH+3)continue;const s=sz*vis*.9;P[ink].rect(x-s,y-s,s*2,s*2);}};
    pass(still,still.length/STRIDE);pass(DYN,dynCount);
    [colors.ink,colors.dna,colors.lyso].forEach((col,i)=>{ctx.fillStyle=col;ctx.fill(P[i]);});
  }

  // ---- running ---------------------------------------------------------------------------------
  // Moving between pages: the opening glides from the old text's shape to the new one's.
  let openingTransition=null;
  function advanceOpening(){
    if(!openingTransition)return false;
    const {from,to,at}=openingTransition,u=clamp((Date.now()-at)/650,0,1),t=S(u);
    box={l:to.l,r:to.r,t:mix(from.t,to.t,t),b:mix(from.b,to.b,t),c:mix(from.c,to.c,t)};
    if(u>=1)openingTransition=null;
    stillAt=-1;return true;
  }
  function frame(now){
    const dt=Math.min(.05,(now-(last||now))/1000);last=now;
    if(!ready){requestAnimationFrame(frame);return;}
    place();const run=!paused&&!reduce.matches&&gpu;let openingChanged=false;
    try{openingChanged=advanceOpening();}catch(err){console.error(err);}
    // Standing still (paused, or reduced motion): draw only when something changed.
    if(!run&&!dirty&&!openingChanged){requestAnimationFrame(frame);return;}dirty=false;
    try{tick=run?dt:0;if(run){time+=dt;updateEvents(dt);mechanics(dt,false);}else if(openingChanged)mechanics(.025,true);dyn();draw();}catch(err){console.error(err);}
    requestAnimationFrame(frame);
  }
  // The canvas is taller than the screen and lies in the page, so the browser scrolls the
  // drawing and the text together and they can never slip apart. CT is where its top sits
  // on the page and CH its height; it is moved along only as the screen nears its edge.
  const sheet=canvas.parentElement,room=()=>Math.min(H*.25,320);
  function tall(){const most=Math.max(H,Math.floor(4096/dpr));return Math.max(1,Math.min(Math.ceil(H+2*room()),most,Math.max(H,sheet.clientHeight)));}
  function fit(){dpr0=devicePixelRatio||1;dpr=Math.min(2,dpr0);CH=tall();
    // A sharp screen is drawn at up to twice its size, but never more than about 4.5 million pixels in all.
    dpr=Math.min(dpr,Math.max(1,Math.sqrt(4.5e6/Math.max(1,W*CH))));canvas.width=Math.round(W*dpr);canvas.height=Math.round(CH*dpr);canvas.style.height=CH+'px';stillAt=-1;place(true);}
  function place(now){
    if(!now&&tall()!==CH){fit();return;}
    const off=sheet.getBoundingClientRect().top+scrollY(),lo=off,hi=off+Math.max(0,sheet.clientHeight-CH),want=clamp(scrollY()-(CH-H)/2,lo,hi);
    if(now||Math.abs(want-CT)>(CH-H)/4||(want!==CT&&(want===lo||want===hi))){CT=want;canvas.style.transform='translateY('+(CT-off)+'px)';stillAt=-1;dirty=true;}
  }
  // The size the tissue was grown for, and where the text stood then.
  let Wb=0,Hb=0,textTop=0,pageHeight=0,shiftX=0,pending=0,hiding=false,force=false;
  const textAt=()=>{const el=document.querySelector('#text .socials')||document.querySelector('#text .portrait')||document.querySelector('#text h1');return el?el.getBoundingClientRect().top+scrollY():0;};
  function grow(done){
    W=sheet.clientWidth;H=innerHeight;fit();DH=Math.max(H,document.documentElement.scrollHeight);Wb=W;Hb=H;shiftX=0;textTop=textAt();pageHeight=DH;force=false;readColors();
    if(gl&&!gpu)try{setupGPU();}catch(err){console.error(err);gpu=null;}
    try{build(done);}catch(err){console.error(err);ready=true;if(done)done();}
    dirty=true;if(!started){started=true;requestAnimationFrame(frame);}
  }
  // While the window is being resized the canvas always matches it, so the drawing is
  // never stretched. If the text has moved, the old tissue fades out, and one new tissue
  // is grown once the resizing has stopped.
  function resize(){
    const w=sheet.clientWidth,h=innerHeight;if(w<50||h<50)return;
    if(!cells.length){hiding=true;canvas.style.transition='none';canvas.style.opacity=0;void canvas.offsetWidth;canvas.style.transition='';grow(()=>{hiding=false;show();});return;}
    const dh=Math.max(h,document.documentElement.scrollHeight);
    // A phone's address bar changes the height constantly; only a real change regrows the tissue.
    const regrow=force||w!==Wb||Math.abs(dh-pageHeight)>size||Math.abs(h-Hb)>Math.max(160,Hb*.25)||Math.abs(textAt()-textTop)>3;
    if(w!==W||h!==H||dpr0!==(devicePixelRatio||1)){W=w;H=h;fit();shiftX=(W-Wb)/2;dirty=true;if(ready)try{dyn();draw();}catch(err){console.error(err);}}
    clearTimeout(pending);
    if(!regrow){if(hiding&&ready){hiding=false;show();}return;}
    regrowSoon();
  }
  // The canvas fades quickly for a regrowth; afterwards the stylesheet's own pace returns.
  let easing=0;
  const hide=()=>{clearTimeout(easing);canvas.style.transition='opacity .22s';canvas.style.opacity=0;};
  const show=()=>{canvas.style.opacity='';clearTimeout(easing);easing=setTimeout(()=>{canvas.style.transition='';},320);};
  function regrowSoon(){hiding=true;hide();clearTimeout(pending);pending=setTimeout(()=>{grow(()=>{hiding=false;show();});},reduce.matches?120:280);}
  // A new page in place (About, Writing, a post). If the new text is about as tall as the
  // old and the capillary runs beside it, the cells stay and make room; otherwise it regrows.
  document.addEventListener('site:content-changed',()=>{
    if(!cells.length)return;
    const dh=Math.max(innerHeight,document.documentElement.scrollHeight),previous=box?{...box}:null;
    if(!ready||hiding||!previous||dh>DH+size*.5||(cap&&!cap.v)){force=true;regrowSoon();return;}
    clearTimeout(pending);pageHeight=dh;textTop=textAt();measure();
    // A much taller or shorter page would leave the cells badly stretched or crushed: regrow instead.
    if(!box||Math.abs((box.b-box.t)-(previous.b-previous.t))>size*2.5){box=previous;force=true;regrowSoon();return;}
    if(!reduce.matches){openingTransition={from:previous,to:{...box},at:Date.now()};box=previous;}else openingTransition=null;
    try{mechanics(.04,true);}catch(err){console.error(err);}stillAt=-1;dirty=true;
  });
  addEventListener('resize',resize);new ResizeObserver(resize).observe(document.documentElement);
  addEventListener('scroll',()=>{if(!ready)return;place();if(!gpu&&dirty){dyn();draw();}},{passive:true});
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>{readColors();stillAt=-1;dirty=true;});
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(resize);
  resize();
  reduce.addEventListener('change',()=>{dirty=true;});
  const toggle=document.querySelector('.motion');
  if(toggle){if(reduce.matches||!gl)toggle.hidden=true;toggle.addEventListener('click',()=>{paused=!paused;dirty=true;toggle.setAttribute('aria-pressed',paused);toggle.textContent=paused?'Play':'Pause';});}
  // Click an ordinary cell and it divides.
  addEventListener('click',e=>{
    if((e.target!==canvas&&e.target.id!=='text')||paused||reduce.matches||!gpu||!ready)return;
    const x=e.clientX-shiftX,y=e.clientY+scrollY();let hit=null,bd=1e18;
    for(const c of cells){if(c.free||!c.n)continue;const d=(c.x-x)**2+(c.y-y)**2-c.w;if(d<bd){bd=d;hit=c;}}
    const waiting=events.filter(v=>v.type==='div'&&!v.split).length;
    if(!hit||hit.kind!=='cell'||hit.ev||hit.grow||pool.length<2*(waiting+1))return;
    if(events.some(v=>Math.hypot((v.cx??v.c.cx)-hit.cx,(v.cy??v.c.cy)-hit.cy)<size*1.6))return;
    startDivision(hit);lastEvent='div';
  });
  // For testing: add ?debug to the address to inspect the tissue from the console.
  if(new URLSearchParams(location.search).has('debug'))window.__tissue={get cells(){return cells},get tissue(){return tissue},get cap(){return cap},get events(){return events},get pool(){return pool},get procs(){return procs},get time(){return time},startDivision,startExtrusion,get lam(){return lam},get dynCount(){return dynCount}};
})();
