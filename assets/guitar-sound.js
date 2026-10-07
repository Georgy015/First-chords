// First Chords guitar sound: a steel-string acoustic synthesized in the browser
// (Karplus-Strong plucked strings, body resonance and a small room). Shared by the Plus pages.
(function(){
  let actx=null; const cache={};
  // one vibrating string: Karplus-Strong loop with a 3-tap damping filter and a
  // fractional-delay allpass for exact pitch. damp (0..0.25) sets how fast the
  // high overtones die away; thick strings get more so they sound warm, not wiry.
  function ksVoice(sr,freq,len,rho,pos,bright,damp,amp){
    const out=new Float32Array(len);
    const D=sr/freq, N=Math.floor(D-0.5), frac=D-N, C=(1-frac)/(1+frac);
    const exc=new Float32Array(N+1); let lp=0;
    for(let i=0;i<=N;i++){lp+=bright*((Math.random()*2-1)-lp); exc[i]=lp;}
    const p=Math.max(1,Math.round(N*pos));
    for(let i=N;i>=p;i--) exc[i]-=exc[i-p];
    let peak=0; for(let i=0;i<=N;i++) peak=Math.max(peak,Math.abs(exc[i]));
    let apX=0, apY=0; const mid=1-2*damp;
    for(let n=0;n<len;n++){
      const a=n>=N-1?out[n-N+1]:0, b=n>=N?out[n-N]:0, c=n>N?out[n-N-1]:0;
      const v=rho*(damp*a+mid*b+damp*c);
      const y=C*v+apX-C*apY; apX=v; apY=y;
      out[n]=y+(n<=N?exc[n]/peak*amp:0);
    }
    return out;
  }
  function pluck(freq){
    const sr=actx.sampleRate, len=Math.floor(sr*2.1);
    // two vibration planes of a steel string, plucked over the soundhole for a full tone
    const damp=Math.min(0.25,0.25*98/freq);
    const bright=Math.min(0.6,0.12*Math.pow(freq/82,1.1));
    const a=ksVoice(sr,freq,len,0.9997,0.21,bright,damp,0.6);
    const b=ksVoice(sr,freq,len,0.9993,0.27,bright*0.8,damp,0.45);
    const L=new Float32Array(len), R=new Float32Array(len);
    // shape to about 2 seconds: natural decay, then a gentle fade-out
    const fadeStart=sr*1.6;
    for(let n=0;n<len;n++){
      let g=Math.exp(-n/(sr*1.5));
      if(n>fadeStart) g*=Math.max(0,1-(n-fadeStart)/(len-fadeStart));
      L[n]=(a[n]*0.62+b[n]*0.38)*g; R[n]=(a[n]*0.38+b[n]*0.62)*g;
    }
    // even out loudness across strings
    let pk=0; for(let n=0;n<len;n++) pk=Math.max(pk,Math.abs(L[n]),Math.abs(R[n]));
    const k=0.32/pk; for(let n=0;n<len;n++){L[n]*=k; R[n]*=k;}
    const buf=actx.createBuffer(2,len,sr); buf.copyToChannel(L,0); buf.copyToChannel(R,1); return buf;
  }
  let room=null;
  function roomIR(){
    // short, soft room: decaying stereo noise, darker as it fades
    const sr=actx.sampleRate, len=Math.floor(sr*0.9), ir=actx.createBuffer(2,len,sr);
    for(let c=0;c<2;c++){
      const d=ir.getChannelData(c); let lp=0;
      for(let i=0;i<len;i++){const k=0.5-0.4*i/len; lp+=k*((Math.random()*2-1)-lp); d[i]=lp*Math.exp(-i/(sr*0.22));}
    }
    return ir;
  }
  function ctx(){
    if(!actx) actx=new (window.AudioContext||window.webkitAudioContext)();
    if(actx.state==='suspended') actx.resume();
    return actx;
  }
  function play(freq,delay=0,level=1){
    ctx();
    const buf=cache[freq]||(cache[freq]=pluck(freq));
    const src=actx.createBufferSource(); src.buffer=buf;
    // steel-string top end kept clear, with a strong guitar body underneath
    const tone=actx.createBiquadFilter(); tone.type='lowpass'; tone.frequency.value=6000; tone.Q.value=0.4;
    const air=actx.createBiquadFilter(); air.type='peaking'; air.frequency.value=100; air.Q.value=1.2; air.gain.value=7;
    const top=actx.createBiquadFilter(); top.type='peaking'; top.frequency.value=200; top.Q.value=1.0; top.gain.value=5;
    const warm=actx.createBiquadFilter(); warm.type='lowshelf'; warm.frequency.value=350; warm.gain.value=3;
    const sparkle=actx.createBiquadFilter(); sparkle.type='peaking'; sparkle.frequency.value=2800; sparkle.Q.value=0.8; sparkle.gain.value=1.5;
    const lvl=actx.createGain(); lvl.gain.value=level;
    const dry=actx.createGain(); dry.gain.value=1.3;
    const wet=actx.createGain(); wet.gain.value=0.45;
    if(!room){room=actx.createConvolver(); room.buffer=roomIR(); room.connect(wet); wet.connect(actx.destination);}
    src.connect(tone).connect(air).connect(top).connect(warm).connect(sparkle).connect(lvl).connect(dry).connect(actx.destination);
    lvl.connect(room);
    src.start(actx.currentTime+delay);
    return {src,out:lvl};
  }


  const OPEN=[82.41,110,146.83,196,246.94,329.63]; // low E to high e
  // strum a chord given frets per string (low E..high e, null = muted); dir 'D' or 'U'
  function strum(frets,dir='D',level=0.42){
    ctx();
    const notes=[]; frets.forEach((f,i)=>{ if(f!==null&&f!==undefined) notes.push(OPEN[i]*Math.pow(2,f/12)); });
    const seq=dir==='U'?notes.slice().reverse():notes;
    return seq.map((fq,k)=>play(fq,k*0.03,level));
  }
  // one note: string index 0 = low E .. 5 = high e, fret number
  function note(string,fret,delay=0,level=0.9){ ctx(); return play(OPEN[string]*Math.pow(2,fret/12),delay,level); }
  // Play a single-note line in time. notes = [[string, fret, beats], ...]; bpm() is read for every
  // note, so speed changes apply straight away. Notes are scheduled just ahead on the audio clock,
  // and onNote(i) fires from the same clock, so the highlight always matches what you hear.
  function sequence({notes,bpm,onNote,onEnd,level=0.85}){
    ctx();
    let stopped=false, i=0, next=0, prev=null, endAt=null, timer=null, raf=null;
    const live=[], due=[];
    function tick(){
      while(!stopped&&i<notes.length&&next<actx.currentTime+0.12){
        const [s,f,d=1]=notes[i], len=d*60/bpm();
        const h=note(s,f,Math.max(0,next-actx.currentTime),level);
        if(prev) prev.out.gain.setTargetAtTime(0,next,0.025);   // the last note stops as this one starts
        h.out.gain.setTargetAtTime(0,next+len+0.1,0.08);         // and each note ends after its own length
        live.push(h); if(live.length>6) live.shift();
        prev=h; due.push([next,i]); next+=len; i++;
      }
      if(i>=notes.length&&endAt===null) endAt=next;
    }
    function frame(){
      if(stopped) return;
      const t=actx.currentTime;
      while(due.length&&due[0][0]<=t){ const idx=due.shift()[1]; if(onNote) onNote(idx); }
      if(endAt!==null&&!due.length&&t>=endAt){ finish(); return; }
      raf=requestAnimationFrame(frame);
    }
    function begin(){ if(stopped) return; next=actx.currentTime+0.08; tick(); timer=setInterval(tick,25); raf=requestAnimationFrame(frame); }
    function finish(){ stopped=true; clearInterval(timer); if(onEnd) onEnd(); }
    if(actx.state!=='running') actx.resume().then(begin,begin); else begin();
    return { stop(){
      if(stopped) return; stopped=true; clearInterval(timer); cancelAnimationFrame(raf);
      const t=actx.currentTime;
      live.forEach(v=>{ try{ v.out.gain.cancelScheduledValues(t); v.out.gain.setTargetAtTime(0,t,0.02); v.src.stop(t+0.15); }catch(e){} });
    }};
  }
  window.FCSound={ctx,play,note,strum,sequence,OPEN,get time(){ return actx?actx.currentTime:0; }};
})();
