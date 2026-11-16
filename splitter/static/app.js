'use strict';
const $ = id => document.getElementById(id);
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const PEAKS = 1600;

// ------------------------------------------------------------ library

let library = [];
let currentId = null;
let autoOpen = null;      // id of the song to open as soon as it finishes
let pollTimer = null;

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

async function refresh() {
  clearTimeout(pollTimer);
  try {
    library = (await api('api/songs')).songs;
  } catch (err) {
    pollTimer = setTimeout(refresh, 3000);
    return;
  }
  renderLibrary();
  const ready = library.find(s => s.id === autoOpen);
  if (ready && ready.status === 'done') { autoOpen = null; openSong(ready); }
  if (ready && ready.status === 'error') autoOpen = null;
  if (library.some(s => s.status === 'queued' || s.status === 'processing')) {
    pollTimer = setTimeout(refresh, 1000);
  }
}

function renderLibrary() {
  const list = $('songs');
  list.textContent = '';
  $('empty').hidden = library.length > 0;
  for (const song of library) {
    const li = document.createElement('li');
    li.className = 'song' + (song.id === currentId ? ' current' : '');
    const info = document.createElement('div');
    info.className = 'info';
    const title = document.createElement('div');
    title.className = 't';
    title.textContent = song.title;
    const detail = document.createElement('div');
    detail.className = 'd';
    info.append(title, detail);
    li.append(info);

    if (song.status === 'done') {
      detail.textContent = `${fmt(song.duration)} · ${song.stems.length} stems`;
      const open = document.createElement('button');
      open.className = 'btn';
      open.textContent = 'Open';
      open.disabled = song.id === currentId;
      open.onclick = () => openSong(song);
      li.append(open);
    } else if (song.status === 'error') {
      detail.textContent = song.error || 'Something went wrong';
      detail.classList.add('err');
    } else {
      const pct = Math.round(song.progress * 100);
      detail.textContent = song.status === 'queued' ? 'Waiting in line'
        : `${song.stage || 'Working'}${song.stage === 'Separating' ? ` · ${pct}%` : ''}`;
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('i');
      fill.style.width = `${pct}%`;
      bar.append(fill);
      info.append(bar);
    }
    if (song.status !== 'processing') {
      const del = document.createElement('button');
      del.className = 'btn';
      del.textContent = 'Delete';
      del.onclick = () => removeSong(song);
      li.append(del);
    }
    list.append(li);
  }
}

async function removeSong(song) {
  if (!confirm(`Delete "${song.title}" and its stems?`)) return;
  try {
    await api(`api/songs/${song.id}`, { method: 'DELETE' });
    if (song.id === currentId) closePlayer();
  } catch (err) {
    alert(err.message);
  }
  refresh();
}

// ------------------------------------------------------------- upload

function setMsg(el, text, isError) {
  el.textContent = text || '';
  el.classList.toggle('err', !!isError);
}

function upload(file) {
  if (!file) return;
  const model = document.querySelector('input[name=model]:checked').value;
  const msg = $('uploadMsg');
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `api/songs?model=${model}&name=${encodeURIComponent(file.name)}`);
  xhr.upload.onprogress = e => setMsg(msg, `Uploading ${file.name}… ${Math.round(e.loaded / e.total * 100)}%`);
  xhr.onerror = () => setMsg(msg, 'Upload failed. Is the server still running?', true);
  xhr.onload = () => {
    let body = {};
    try { body = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
    if (xhr.status >= 300) return setMsg(msg, body.error || 'Upload failed.', true);
    setMsg(msg, '');
    autoOpen = body.id;
    refresh();
  };
  xhr.send(file);
}

$('pick').onclick = () => $('file').click();
$('file').onchange = e => { upload(e.target.files[0]); e.target.value = ''; };

let dragDepth = 0;
const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dragging'); } });
addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  for (const file of e.dataTransfer.files) upload(file);
});

// ------------------------------------------------------------- player

let ctx = null;
let tracks = [];          // {name, buffer, gain, source, volume, muted, solo, peaks, row, canvas}
let duration = 0;
let playing = false;
let startedAt = 0;        // ctx time when playback (re)started
let startOffset = 0;      // song position at that moment
let looping = false;
let region = null;        // {a, b} in seconds
let loadToken = 0;

function closePlayer() {
  loadToken++;
  stopSources();
  playing = false;
  tracks.forEach(t => { t.gain.disconnect(); t.row.remove(); });
  tracks = [];
  currentId = null;
  $('player').hidden = true;
}

async function openSong(song) {
  closePlayer();
  const token = loadToken;
  currentId = song.id;
  renderLibrary();
  ctx = ctx || new AudioContext({ sampleRate: 44100 });
  $('player').hidden = false;
  $('title').textContent = song.title;
  $('dur').textContent = fmt(song.duration);
  $('cur').textContent = '0:00';
  $('play').disabled = true;
  region = null; looping = false; startOffset = 0;
  $('loop').setAttribute('aria-pressed', 'false');
  drawRegion();
  setIcon();
  $('player').scrollIntoView({ behavior: 'smooth', block: 'start' });

  let loaded = 0;
  setMsg($('playerMsg'), `Loading stems… 0/${song.stems.length}`);
  try {
    const buffers = await Promise.all(song.stems.map(async name => {
      const res = await fetch(`media/${song.id}/${name}.wav`);
      if (!res.ok) throw new Error(`Couldn't load the ${name} stem`);
      const buffer = await ctx.decodeAudioData(await res.arrayBuffer());
      if (token === loadToken) setMsg($('playerMsg'), `Loading stems… ${++loaded}/${song.stems.length}`);
      return buffer;
    }));
    if (token !== loadToken) return;
    duration = Math.max(...buffers.map(b => b.duration));
    $('dur').textContent = fmt(duration);
    const peaks = buffers.map(computePeaks);
    const loudest = Math.max(0.05, ...peaks.map(p => p.max));
    tracks = song.stems.map((name, i) => makeTrack(song, name, buffers[i], peaks[i], loudest));
    setMsg($('playerMsg'), '');
    $('play').disabled = false;
    drawAll();
  } catch (err) {
    if (token === loadToken) setMsg($('playerMsg'), err.message, true);
  }
}

function computePeaks(buffer) {
  const data = new Float32Array(PEAKS);
  const step = buffer.length / PEAKS;
  let max = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < PEAKS; i++) {
      let peak = data[i];
      const end = Math.min(ch.length, Math.floor((i + 1) * step));
      for (let j = Math.floor(i * step); j < end; j += 4) {
        const v = Math.abs(ch[j]);
        if (v > peak) peak = v;
      }
      data[i] = peak;
      if (peak > max) max = peak;
    }
  }
  return { data, max };
}

function makeTrack(song, name, buffer, peaks, loudest) {
  const row = document.createElement('div');
  row.className = 'track';
  row.style.setProperty('--c', `var(--${name})`);
  row.innerHTML = `
    <div class="ctl">
      <div class="ms">
        <button type="button" class="m" aria-pressed="false" aria-label="Mute ${name}" title="Mute">M</button>
        <button type="button" class="s" aria-pressed="false" aria-label="Solo ${name}" title="Solo">S</button>
      </div>
      <span class="name">${name}</span>
      <a class="dl" href="media/${song.id}/${name}.wav?download=1" download title="Download ${name} stem" aria-label="Download ${name} stem">
        <svg viewBox="0 0 24 24"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14"/></svg>
      </a>
      <input type="range" class="vol" min="0" max="1.5" step="0.01" value="1" aria-label="${name} volume">
    </div>
    <div class="lane"><canvas></canvas></div>`;
  $('tracks').append(row);

  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  // Quiet stems are scaled up so they stay readable, but never beyond 4x the loudest.
  const scale = 1 / Math.max(peaks.max, loudest / 4);
  const track = { name, buffer, gain, source: null, volume: 1, muted: false, solo: false,
                  peaks: peaks.data, scale, row, canvas: row.querySelector('canvas') };
  const [m, s] = row.querySelectorAll('.ms button');
  m.onclick = () => { track.muted = !track.muted; m.setAttribute('aria-pressed', track.muted); applyGains(); };
  s.onclick = () => { track.solo = !track.solo; s.setAttribute('aria-pressed', track.solo); applyGains(); };
  const vol = row.querySelector('.vol');
  vol.oninput = () => { track.volume = +vol.value; applyGains(); };
  vol.ondblclick = () => { vol.value = 1; vol.oninput(); };
  return track;
}

function audible(t) {
  return tracks.some(x => x.solo) ? t.solo : !t.muted;
}

function applyGains() {
  for (const t of tracks) {
    const on = audible(t);
    t.gain.gain.setTargetAtTime(on ? t.volume : 0, ctx.currentTime, 0.015);
    t.row.classList.toggle('silent', !on || t.volume === 0);
  }
}

$('reset').onclick = () => {
  for (const t of tracks) {
    t.volume = 1; t.muted = false; t.solo = false;
    t.row.querySelector('.vol').value = 1;
    t.row.querySelectorAll('.ms button').forEach(b => b.setAttribute('aria-pressed', 'false'));
  }
  applyGains();
};

// --- transport

function loopBounds() {
  return region || { a: 0, b: duration };
}

function position() {
  if (!playing) return startOffset;
  let pos = startOffset + (ctx.currentTime - startedAt);
  if (looping) {
    const { a, b } = loopBounds();
    if (pos >= b) pos = a + (pos - a) % (b - a);
  }
  return Math.min(pos, duration);
}

function stopSources() {
  for (const t of tracks) {
    if (!t.source) continue;
    t.source.onended = null;
    try { t.source.stop(); } catch (e) { /* already stopped */ }
    t.source.disconnect();
    t.source = null;
  }
}

function startSources(offset) {
  stopSources();
  if (looping) {
    const { a, b } = loopBounds();
    if (offset < a || offset >= b - 0.01) offset = a;
  }
  if (offset >= duration - 0.01) offset = 0;
  const when = ctx.currentTime + 0.03;
  for (const t of tracks) {
    const src = ctx.createBufferSource();
    src.buffer = t.buffer;
    if (looping) {
      const { a, b } = loopBounds();
      src.loop = true; src.loopStart = a; src.loopEnd = b;
    }
    src.connect(t.gain);
    src.start(when, offset);
    t.source = src;
  }
  // The longest stem decides when the song is over.
  const last = tracks.reduce((x, y) => (y.buffer.duration > x.buffer.duration ? y : x));
  last.source.onended = () => { playing = false; startOffset = 0; stopSources(); setIcon(); movePlayhead(); };
  startedAt = when;
  startOffset = offset;
  playing = true;
}

function play() {
  if (!tracks.length || playing) return;
  ctx.resume();
  startSources(startOffset);
  setIcon();
  requestAnimationFrame(tick);
}

function pause() {
  if (!playing) return;
  startOffset = position();
  playing = false;
  stopSources();
  setIcon();
}

function seek(seconds) {
  startOffset = Math.max(0, Math.min(duration, seconds));
  if (playing) startSources(startOffset);
  movePlayhead();
}

function setIcon() {
  $('playIcon').setAttribute('d', playing ? 'M7 5h4v14H7zM13 5h4v14h-4z' : 'M8 5v14l11-7z');
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

function movePlayhead() {
  const pos = position();
  const width = $('overlay').clientWidth;
  $('playhead').style.transform = `translateX(${duration ? pos / duration * width : 0}px)`;
  $('cur').textContent = fmt(pos);
}

function tick() {
  movePlayhead();
  if (playing) requestAnimationFrame(tick);
}

$('play').onclick = () => (playing ? pause() : play());

function setLooping(on) {
  const pos = position();
  looping = on;
  $('loop').setAttribute('aria-pressed', on);
  if (playing) startSources(pos);
}
$('loop').onclick = () => setLooping(!looping);

addEventListener('keydown', e => {
  if (!tracks.length || e.target.closest('input, button, a, select, textarea') && e.code === 'Space' && e.target.type !== 'range') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); }
  else if (e.code === 'KeyL') setLooping(!looping);
  else if (e.target.type === 'range') return;
  else if (e.code === 'ArrowLeft') seek(position() - 5);
  else if (e.code === 'ArrowRight') seek(position() + 5);
  else if (e.code === 'Home') seek(0);
});

// --- waveform interaction: click to seek, drag to select a loop region

function drawRegion() {
  const el = $('region');
  el.hidden = !region;
  if (!region) return;
  el.style.left = `${region.a / duration * 100}%`;
  el.style.width = `${(region.b - region.a) / duration * 100}%`;
}

{
  const overlay = $('overlay');
  let downX = null, dragged = false;
  const timeAt = e => {
    const box = overlay.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * duration;
  };
  overlay.onpointerdown = e => {
    if (!tracks.length || e.button !== 0) return;
    overlay.setPointerCapture(e.pointerId);
    downX = e.clientX; dragged = false;
  };
  overlay.onpointermove = e => {
    if (downX === null) return;
    if (!dragged && Math.abs(e.clientX - downX) < 5) return;
    dragged = true;
    const box = overlay.getBoundingClientRect();
    const t0 = Math.max(0, Math.min(1, (downX - box.left) / box.width)) * duration;
    const t1 = timeAt(e);
    region = { a: Math.min(t0, t1), b: Math.max(t0, t1) };
    drawRegion();
  };
  overlay.onpointerup = e => {
    if (downX === null) return;
    downX = null;
    if (dragged) {
      if (region.b - region.a < 0.2) { region = null; drawRegion(); return; }
      looping = true;
      $('loop').setAttribute('aria-pressed', 'true');
      seek(region.a);
    } else {
      const t = timeAt(e);
      if (region && (t < region.a || t > region.b)) {   // clicking outside clears the selection
        region = null;
        drawRegion();
      }
      seek(t);
    }
  };
  overlay.onpointercancel = () => { downX = null; };
}

// --- drawing

function drawAll() {
  const ratio = window.devicePixelRatio || 1;
  for (const t of tracks) {
    const { canvas, peaks, scale } = t;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w) continue;
    canvas.width = w * ratio; canvas.height = h * ratio;
    const g = canvas.getContext('2d');
    g.scale(ratio, ratio);
    g.fillStyle = getComputedStyle(t.row).getPropertyValue('--c').trim() || '#888';
    const mid = h / 2;
    for (let x = 0; x < w; x++) {
      const from = Math.floor(x / w * PEAKS), to = Math.max(from + 1, Math.floor((x + 1) / w * PEAKS));
      let peak = 0;
      for (let i = from; i < to; i++) if (peaks[i] > peak) peak = peaks[i];
      const half = Math.max(0.5, Math.min(1, peak * scale) * (mid - 3));
      g.fillRect(x, mid - half, 1, half * 2);
    }
  }
  movePlayhead();
}
new ResizeObserver(() => drawAll()).observe($('tracks'));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawAll);

// --- export the current mix as a WAV file

$('exportMix').onclick = async () => {
  const active = tracks.filter(t => audible(t) && t.volume > 0);
  if (!active.length) return setMsg($('playerMsg'), 'Every stem is muted, so there is nothing to export.', true);
  setMsg($('playerMsg'), 'Preparing your mix…');
  await new Promise(r => setTimeout(r, 30));
  const length = Math.max(...active.map(t => t.buffer.length));
  const rate = active[0].buffer.sampleRate;
  const mix = [new Float32Array(length), new Float32Array(length)];
  for (const t of active) {
    for (let c = 0; c < 2; c++) {
      const src = t.buffer.getChannelData(Math.min(c, t.buffer.numberOfChannels - 1));
      const dst = mix[c], vol = t.volume;
      for (let i = 0; i < src.length; i++) dst[i] += src[i] * vol;
    }
  }
  const bytes = new DataView(new ArrayBuffer(44 + length * 4));
  const text = (at, s) => [...s].forEach((ch, i) => bytes.setUint8(at + i, ch.charCodeAt(0)));
  text(0, 'RIFF'); bytes.setUint32(4, 36 + length * 4, true); text(8, 'WAVEfmt ');
  bytes.setUint32(16, 16, true); bytes.setUint16(20, 1, true); bytes.setUint16(22, 2, true);
  bytes.setUint32(24, rate, true); bytes.setUint32(28, rate * 4, true);
  bytes.setUint16(32, 4, true); bytes.setUint16(34, 16, true);
  text(36, 'data'); bytes.setUint32(40, length * 4, true);
  for (let i = 0, at = 44; i < length; i++) {
    for (let c = 0; c < 2; c++, at += 2) {
      bytes.setInt16(at, Math.max(-1, Math.min(1, mix[c][i])) * 32767, true);
    }
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  const left = tracks.length === active.length && active.every(t => t.volume === 1) ? 'mix' : active.map(t => t.name).join('+');
  link.download = `${$('title').textContent} - ${left}.wav`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 60000);
  setMsg($('playerMsg'), '');
};

refresh();
