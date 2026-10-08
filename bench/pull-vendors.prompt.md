You are a one-shot job started by the Slate Lab hub's "Pull ETR + Blick" button. Pull the user's ETR and Blick
projections for ONE slate through his logged-in Chrome, save them into the slate folder, refresh the hub, report,
and stop. Work only on establishtherun.com, blickanalytics.com, discord.com (the Blick login consent screen only)
and http://localhost:8787. Never type a password or any credential anywhere. Do not click anything that buys,
posts, or changes an account setting.

Slate: {{DIR}}  type {{TYPE}}  date {{DATE}}  Stokastic slateId {{SLATEID}}  games {{GAMES}}
Report progress with:  curl -s -X POST http://localhost:8787/api/pull-status -H "content-type: application/json" -d '{"status":"working","message":"..."}'

Saving files: the Write tool refuses to replace a file you haven't read, so before writing any file under data/, Read it
first if it exists (a missing file is fine to write directly). Write only under data/{{DIR}}/.

1. Start: tabs_context_mcp with createIfEmpty true, then work in that tab. Post status working "pulling ETR".

2. ETR.
   {{ETR_STEPS}}

3. Blick. {{BLICK_SKIP}} Post status working "pulling Blick".
   Open {{BLICK_URL}}. If the page says SUBSCRIBERS ONLY, open
   https://blickanalytics.com/api/auth/login?next={{BLICK_NEXT}} ; Discord shows an "Authorize" consent screen for
   Blick Analytics (scopes: username + server roles). Click Authorize. If Discord instead asks for a login or a
   password, STOP Blick and note "Blick needs you to sign in to Discord". Once the table shows, run:
     const R=[...document.querySelectorAll('table tr')].map(tr=>[...tr.children].map(td=>td.innerText.trim().replace(/\s+/g,' ')));
     const n=s=>String(s).replace(/[%+$,]/g,'').replace('−','-').trim();
     const H=R[0].map(h=>h.replace(/\s+/g,' '));
     const body=R.slice(1).filter(r=>r.length===H.length).map(r=>r.map((c,i)=>i<4?(c.includes(',')?'"'+c+'"':c):n(c)).join(','));
     window.__C=[H.join(',')].concat(body.filter(l=>{const f=l.split(',');const p=+f[H.findIndex(h=>/^PROJ$/i.test(h))];return p>=2;})).join('\n');
     'rows '+(window.__C.split('\n').length-1)+' chars '+window.__C.length+' | '+((document.body.innerText.match(/UPDATED[^\n]*/i)||[''])[0])
   Read window.__C in slices of 950 characters (window.__C.slice(0,950), slice(950,1900), ...) using browser_batch,
   join them exactly, and Write the file to data/{{DIR}}/{{BLICK_FILE}} .

3b. Blick Conditional Ownership (combo ownership; optional - skip with a note if anything below fails). In the same tab
   open https://blickanalytics.com/nfl/conditional-ownership{{BLICK_COND_SUFFIX}} and wait 5 seconds. Run:
     const U=performance.getEntriesByType('resource').map(e=>e.name).filter(n=>/conditional-own-nfl/.test(n));
     const S=JSON.parse(await (await fetch(U.find(n=>!/contest/.test(n))||U[0])).text());
     S.event+' | '+S.built_at+' | '+S.contests.map(c=>c.key+' '+c.label+' '+c.own_profile).join(' / ')
   If the event is not this slate (other teams or another week), skip 3b and note "Blick conditional: not posted
   for this slate". Otherwise pick the contest: classic = the one with own_profile "pOwn HS" (else the first);
   showdown = the highest entry fee. Then run the block for the slate type, with KEY set to that contest's key:
   CLASSIC:
     const KEY='...'; const u=new URL(U[U.length-1]); u.searchParams.set('contest',KEY); const C=JSON.parse(await (await fetch(u)).text());
     const P=S.players,k=C.k,n=C.n,W=C.w,tw=W.reduce((a,b)=>a+b,0),L=[];for(let i=0;i<n;i++)L.push(new Set(C.rows.slice(i*k,i*k+k)));
     const own=new Array(P.length).fill(0);L.forEach((l,i)=>l.forEach(p=>own[p]+=W[i]));const pct=x=>+(100*x/tw).toFixed(2);
     const game=p=>[P[p].team,P[p].opp].sort().join('@');const sum=f=>{let s=0;L.forEach((l,i)=>{if(f(l))s+=W[i];});return s;};
     const qbs=P.map((p,i)=>i).filter(i=>P[i].pos==='QB'&&pct(own[i])>=1).sort((a,b)=>own[b]-own[a]).slice(0,16),lines=[],used=new Set();
     for(const q of qbs){used.add(q);const mates=P.map((p,i)=>i).filter(i=>i!==q&&game(i)===game(q)&&P[i].pos!=='DST'&&P[i].proj>=4);
       const cat=mates.filter(m=>P[m].team===P[q].team&&/WR|TE/.test(P[m].pos)).sort((a,b)=>P[b].proj-P[a].proj).slice(0,4);
       const opp=mates.filter(m=>P[m].team!==P[q].team).sort((a,b)=>P[b].proj-P[a].proj).slice(0,6);mates.forEach(m=>used.add(m));
       const one=mates.map(m=>m+':'+pct(sum(l=>l.has(q)&&l.has(m))));const two=[];for(let a=0;a<cat.length;a++)for(let b=a+1;b<cat.length;b++)two.push(cat[a]+'.'+cat[b]+':'+pct(sum(l=>l.has(q)&&l.has(cat[a])&&l.has(cat[b]))));
       const tri=[];for(const c of cat)for(const o of opp)tri.push(c+'.'+o+':'+pct(sum(l=>l.has(q)&&l.has(c)&&l.has(o))));
       lines.push('Q'+q+'|'+pct(own[q])+'|'+one.join(',')+'|'+two.join(',')+'|'+tri.join(','));}
     window.__B='EVENT '+S.event.replace(/[^\w ]/g,'')+' | BUILT '+C.built_at+' | CONTEST '+KEY+' | ENTRIES '+S.contests.find(c=>c.key===KEY).entries+' | N '+n+' | W '+tw.toFixed(1)+'\nP '+[...used].sort((a,b)=>a-b).map(i=>i+'~'+P[i].name+'~'+P[i].team+'~'+P[i].pos+'~'+pct(own[i])).join('^')+'\n'+lines.join('\n');
     window.__B.length
   SHOWDOWN (players carry slot FLEX/CPT and `pair` = the same player's other slot):
     const KEY='...'; const u=new URL(U[U.length-1]); u.searchParams.set('contest',KEY); const C=JSON.parse(await (await fetch(u)).text());
     const P=S.players,k=C.k,n=C.n,W=C.w,tw=W.reduce((a,b)=>a+b,0),pct=x=>+(100*x/tw).toFixed(2),N=P.length/2;
     const L=[];for(let i=0;i<n;i++){const l=C.rows.slice(i*k,i*k+k),c=l.find(p=>P[p].slot==='CPT');L.push({cpt:P[c].pair,flex:l.filter(p=>p!==c)});}
     const cO=new Array(N).fill(0),fO=new Array(N).fill(0);L.forEach((l,i)=>{cO[l.cpt]+=W[i];for(const p of l.flex)fO[p]+=W[i];});
     const side={};L.forEach((l,i)=>{const c={};[l.cpt,...l.flex].forEach(p=>c[P[p].team]=(c[P[p].team]||0)+1);const [t,m]=Object.entries(c).sort((a,b)=>b[1]-a[1])[0];const key=m===3?'3-3':m+'-'+(6-m)+' '+t;side[key]=(side[key]||0)+W[i];});
     const caps=[...Array(N).keys()].filter(i=>pct(cO[i])>=1).sort((a,b)=>cO[b]-cO[a]);
     const lines=caps.map(c=>{const pr={};L.forEach((l,i)=>{if(l.cpt!==c)return;for(const p of l.flex)pr[p]=(pr[p]||0)+W[i];});return 'C'+c+'|'+pct(cO[c])+'|'+Object.entries(pr).filter(([p,v])=>pct(v)>=0.05).map(([p,v])=>p+':'+pct(v)).join(',');});
     const used=[...Array(N).keys()].filter(i=>pct(fO[i])>=0.3||pct(cO[i])>=0.3);
     window.__B='EVENT '+S.event.replace(/[^\w @]/g,'')+' | BUILT '+C.built_at+' | CONTEST '+KEY+' | ENTRIES '+S.contests.find(c=>c.key===KEY).entries+' | N '+n+' | W '+tw.toFixed(1)+'\nP '+used.map(i=>i+'~'+P[i].name+'~'+P[i].team+'~'+P[i].pos+'~'+pct(fO[i])+'~'+pct(cO[i])).join('^')+'\nS '+Object.entries(side).map(([a,v])=>a+':'+pct(v)).join(',')+'\n'+lines.join('\n');
     window.__B.length
   Read window.__B in slices of 950 characters with browser_batch (the text deliberately has no = ; & so the tool
   output isn't filtered), join them exactly, Write data/{{DIR}}/blick-conditional.raw.txt, then file it:
     curl -s -X POST "http://localhost:8787/api/blick-cond?dir={{DIR}}" --data-binary @data/{{DIR}}/blick-conditional.raw.txt
   Note the reply's rows count for the final status ("Blick conditional <contest> <rows> combos").

4. Close the tab you opened. Refresh the hub:
     curl -s -X POST http://localhost:8787/api/refresh -H "content-type: application/json" -d '{"date":"{{DATE}}","slateId":"{{SLATEID}}"}'
   From its JSON, read steps[name=merge].info.sources and note the etr and blick row counts.

5. Finish with ONE status post: {"status":"done","message":"ETR <rows> (<ETR stamp>), Blick <rows> (<Blick UPDATED stamp>)"}
   or, if a source failed, {"status":"done","message":"ETR ..., Blick failed: <why>"}; if both failed use "error".
   Then reply with that same one line and nothing else.
