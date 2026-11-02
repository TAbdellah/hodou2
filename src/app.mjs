import { SessionEngine, MicrophoneInput, compareSessions, clamp } from './engine.mjs';
import { messages } from './i18n.mjs';

const $ = id => document.getElementById(id);
const HISTORY_KEY = 'hodou2.history.v1', ACTIVE_KEY = 'hodou2.active.v1';
let storageAvailable = true;
function readStore(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
  catch { storageAvailable = false; return fallback; }
}
function writeStore(key, value) {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); }
  catch { storageAvailable = false; toast('storageError'); }
}
let lang = readStore('hodou2.language', 'ar');
if (!messages[lang]) lang = 'ar';
let records = readStore(HISTORY_KEY, []);
function validRecord(r) {
  return r && ['mic','demo'].includes(r.source) && r.config && ['individual','group'].includes(r.config.mode)
    && Number.isFinite(r.endedAt) && r.endedAt > 0 && r.endedAt < 1e14
    && ['elapsed','above','percentage','reminders','alerts'].every(k => Number.isFinite(r[k]) && r[k] >= 0)
    && ['threshold','delay','gain','duration'].every(k => Number.isFinite(r.config[k]) && r.config[k] > 0)
    && typeof r.config.feedback === 'boolean';
}
records = Array.isArray(records) ? records.filter(validRecord).slice(0,100) : [];
const microphone = new MicrophoneInput();
let engine = null, displayRecord = null, running = false, starting = false;
let startGeneration = 0, startedAt = 0, manualLevel = 22, smoothed = 0;
let trace = [], lastFrame = performance.now(), lastRender = 0, lastSample = 0, lastSave = 0;
let currentView = 'live', projector = false, toastTimer;
const t = (key, values = {}) => (messages[lang][key] ?? key).replace(/\{(\w+)\}/g, (_, k) => values[k] ?? '');
const number = (n, digits = 0) => new Intl.NumberFormat(lang === 'ar' ? 'ar-MA' : 'fr-FR', { numberingSystem:'latn', maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);
const clock = s => `${String(Math.floor(Math.max(0,s)/60)).padStart(2,'0')}:${String(Math.floor(Math.max(0,s)%60)).padStart(2,'0')}`;
const setText = (id, value) => { const el = $(id); if (el.textContent !== String(value)) el.textContent = value; };
const escapeHTML = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function toast(key) {
  $('toast').textContent = t(key);
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000);
}
function config() {
  return {
    mode: document.querySelector('input[name="activity"]:checked').value,
    source: document.querySelector('input[name="source"]:checked').value,
    threshold: Number($('thresholdInput').value), delay: Number($('delayInput').value),
    duration: Number($('durationInput').value), gain: Number($('gainInput').value),
    feedback: $('feedbackInput').checked
  };
}
function applyLanguage() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.title = t('pageTitle');
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-aria-i18n]').forEach(el => el.setAttribute('aria-label',t(el.dataset.ariaI18n)));
  updateConfiguration(); renderHistory(); renderLive();
}
function showView(view) {
  if (projector && view !== 'live') setProjector(false);
  currentView = view;
  document.querySelectorAll('.view').forEach(el => { el.hidden = el.id !== `view-${view}`; });
  document.querySelectorAll('[data-view]').forEach(el => {
    const selected = el.dataset.view === view;
    el.classList.toggle('active', selected); el.setAttribute('aria-selected', String(selected));
    el.tabIndex = selected ? 0 : -1;
  });
  if (view === 'history') renderHistory();
}
function updateConfiguration() {
  const c = engine?.config ?? config();
  setText('thresholdOutput',`${number(c.threshold)} / 100`);
  setText('delayOutput',`${number(c.delay)} ${lang === 'ar' ? 'ث' : 's'}`);
  setText('gainOutput',`${number(c.gain,1)}×`);
  setText('activityCaption',t(c.mode));
  setText('feedbackCaption',t('feedbackCaption',{n:number(c.threshold),delay:number(c.delay)}));
  $('demoCard').hidden = c.source !== 'demo';
  $('sourceBadge').className = `pill ${c.source === 'demo' ? 'demo' : 'real'}`;
  $('sourceBadge').querySelector('span').textContent = t(c.source === 'demo' ? 'demoBadge' : 'sourceMic');
  $('settingsFieldset').disabled = running || starting;
  $('lockedNote').hidden = !running;
}
function signalState() {
  if (!engine) return displayRecord ? 'finished' : 'ready';
  if (engine.paused) return 'paused';
  if (!engine.config.feedback) return 'baseline';
  return engine.signal === 'idle' ? 'green' : engine.signal;
}
function renderLive() {
  const state = signalState(), c = engine?.config ?? displayRecord?.config ?? config();
  const data = engine ? engine.snapshot() : displayRecord;
  const showFeedback = running && !!engine?.config.feedback && !engine.paused;
  $('device').dataset.signal = ['ready','finished'].includes(state) ? 'idle' : state;
  setText('signalTitle',t(state === 'amber' && engine?.pending > 0 ? 'pending' : state));
  setText('signalHelp',t(({ green:'greenHelp',amber:'amberHelp',red:'redHelp',paused:'pausedHelp',baseline:'baselineHelp',ready:'readyHelp',finished:'finishedHelp' })[state]));
  const icon = state === 'green' ? 'check' : state === 'red' ? 'alert' : state === 'paused' ? 'pause' : 'wave';
  $('stateIcon').setAttribute('href',`#i-${icon}`);
  setText('levelValue', showFeedback ? number(Math.round(engine.level)) : '—');
  $('unitLabel').hidden = !showFeedback;
  $('powerDot').classList.toggle('on',running && !engine?.paused);
  $('delayProgress').style.width = `${showFeedback ? Math.min(100,engine.pending/c.delay*100) : 0}%`;
  setText('delayLabel',showFeedback && engine.pending > 0 ? t('pendingSeconds',{n:number(Math.min(engine.pending,c.delay),1),delay:number(c.delay)}) : '\u00a0');
  setText('elapsedValue',clock(data?.elapsed ?? 0));
  setText('remainingValue',`${clock(Math.ceil(Math.max(0,c.duration-(data?.elapsed??0))))} ${t('remaining')}`);
  const visibleMetrics = !!data && (!running || c.feedback);
  setText('overValue',visibleMetrics ? clock(data.above) : '—');
  setText('overPercent',visibleMetrics ? `${number(data.percentage,1)} %` : '—');
  setText('alertValue',visibleMetrics ? number(data.alerts) : '—');
  setText('alertDetail',`${number(c.delay)} ${t('seconds')}`);
  setText('reminderCount',number(data?.reminders??0));
  $('reminderButton').disabled = !running;
  $('startButton').hidden = running;
  $('startButton').disabled = starting;
  $('startButton').querySelector('span').textContent = t(starting ? 'loading' : 'start');
  $('cancelStartButton').hidden = !starting;
  $('pauseButton').hidden = !running;
  $('stopButton').hidden = !running;
  $('devicePause').disabled = !running;
  $('pauseButton').querySelector('span').textContent = t(engine?.paused ? 'resume' : 'pause');
  $('pauseButton').querySelector('use').setAttribute('href',engine?.paused ? '#i-play' : '#i-pause');
  $('devicePause').querySelector('use').setAttribute('href',engine?.paused ? '#i-play' : '#i-pause');
  $('devicePause').setAttribute('aria-label',t(engine?.paused ? 'resume' : 'pause'));
  drawTrace(showFeedback,c.threshold);
}
function drawTrace(visible, threshold) {
  $('thresholdPath').style.visibility = visible ? 'visible' : 'hidden';
  const y = value => (94-clamp(value)*.86).toFixed(1);
  $('thresholdPath').setAttribute('d',`M0 ${y(threshold)}H360`);
  const points = visible ? trace.slice(-61) : [];
  const d = points.map((v,i)=>`${i?'L':'M'}${(i*6).toFixed(1)} ${y(v)}`).join(' ');
  $('tracePath').setAttribute('d',d);
  $('traceFill').setAttribute('d',points.length ? `${d}L${(points.length-1)*6} 100L0 100Z` : '');
}
async function startSession() {
  if (running || starting) return;
  const requested = ++startGeneration, c = config();
  displayRecord = null; starting = true; updateConfiguration(); renderLive();
  try {
    if (c.source === 'mic') {
      const ok = await microphone.start();
      if (!ok || requested !== startGeneration) return;
    }
    if (requested !== startGeneration) return;
    engine = new SessionEngine(c); running = true; startedAt = Date.now();
    smoothed = 0; trace = []; lastSample = 0; lastSave = 0; lastFrame = performance.now();
  } catch (error) {
    const key = ['NotAllowedError','SecurityError'].includes(error.name) ? 'micDenied' : error.name === 'NotFoundError' ? 'micMissing' : error.name === 'UnavailableError' ? 'micUnavailable' : 'micBusy';
    if (requested === startGeneration) toast(key);
  } finally {
    if (requested === startGeneration) { starting = false; updateConfiguration(); renderLive(); }
  }
}
function cancelStart() {
  startGeneration++; starting = false; microphone.stop(); updateConfiguration(); renderLive();
}
function pauseSession() {
  if (!engine || !running) return;
  if (engine.paused) engine.resume(); else engine.pause();
  smoothed = 0; lastFrame = performance.now(); saveActive(); renderLive();
}
function recordSnapshot(reason = 'active') {
  return { id:`${startedAt}`, source:engine.config.source, config:{...engine.config}, startedAt,
    endedAt:Date.now(), ...engine.snapshot(), complete:engine.finished && reason === 'complete', reason };
}
function saveActive() { if (engine) writeStore(ACTIVE_KEY,recordSnapshot()); }
function finishSession(reason = 'manual') {
  if (!engine || !running) return;
  const record = recordSnapshot(reason);
  records = [record,...records].slice(0,100);
  writeStore(HISTORY_KEY,records); writeStore(ACTIVE_KEY,null);
  displayRecord = record; engine = null; running = false; microphone.stop();
  updateConfiguration(); renderLive(); renderHistory(); toast(storageAvailable ? 'saved' : 'storageError');
}
function demoReading(elapsed) {
  if (!$('autoInput').checked) return manualLevel;
  const phase = elapsed % 28;
  const base = phase < 7 ? 24 : phase < 14 ? 54 : phase < 21 ? 87 : 26;
  return clamp(base + Math.sin(elapsed*3.5)*2.2 + Math.sin(elapsed*7.3)*1.3);
}
function tick(now) {
  const dt = Math.max(0,Math.min((now-lastFrame)/1000,.25)); lastFrame = now;
  if (engine && running && !engine.paused) {
    const raw = engine.config.source === 'demo' ? demoReading(engine.elapsed) : microphone.read(engine.config.gain);
    if (engine.config.source === 'demo' && $('autoInput').checked) {
      $('demoInput').value = Math.round(raw); setText('demoOutput',number(Math.round(raw)));
    }
    smoothed += (raw-smoothed)*(1-Math.exp(-dt/0.15));
    engine.step(smoothed,dt);
    if (now-lastSample > 500) { trace.push(smoothed); if(trace.length>61)trace.shift(); lastSample=now; }
    if (now-lastSave > 1000) { saveActive(); lastSave=now; }
    if (engine.finished) finishSession('complete');
  }
  if (now-lastRender > 100) { if (currentView === 'live') renderLive(); lastRender=now; }
  requestAnimationFrame(tick);
}
function renderHistory() {
  setText('recordCount',number(records.length));
  $('emptyHistory').hidden = records.length > 0;
  $('historyTableWrap').hidden = !records.length;
  $('exportButton').disabled = !records.length; $('clearButton').disabled = !records.length;
  $('historyRows').innerHTML = records.map((r,i)=>{
    const when = new Intl.DateTimeFormat(lang === 'ar' ? 'ar-MA' : 'fr-FR',{numberingSystem:'latn',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(r.endedAt));
    const status = r.complete ? 'completed' : r.reason === 'interrupted' ? 'interrupted' : 'short';
    return `<tr><td><strong>${escapeHTML(t('record'))} ${number(records.length-i)}</strong><small>${escapeHTML(when)} · ${escapeHTML(t(r.config.mode))}</small><span class="status-tag">${escapeHTML(t(status))}</span></td><td><span class="pill ${r.source==='demo'?'demo':'real'}">${escapeHTML(t(r.source==='demo'?'demo':'mic'))}</span></td><td>${escapeHTML(t(r.config.feedback?'on':'off'))}</td><td dir="ltr">${clock(r.elapsed)}</td><td><strong dir="ltr">${number(r.percentage,1)} %</strong><small dir="ltr">${clock(r.above)}</small></td><td>${number(r.reminders)}</td></tr>`;
  }).join('');
  const comparison = compareSessions(records);
  if (!comparison) $('comparisonBody').innerHTML = `<p>${escapeHTML(t('comparisonEmpty'))}</p>`;
  else {
    const {baseline,withFeedback,difference} = comparison;
    $('comparisonBody').innerHTML = `<div class="comparison-values"><div><span>${escapeHTML(t('baselineLabel'))}</span><strong dir="ltr">${number(baseline.percentage,1)} %</strong></div><div><span>${escapeHTML(t('withLabel'))}</span><strong dir="ltr">${number(withFeedback.percentage,1)} %</strong></div><div><span>${escapeHTML(t('observedDifference'))}</span><strong dir="ltr">${difference>0?'+':''}${number(difference,1)}</strong><small>${escapeHTML(t('pp'))}</small></div></div><p>${escapeHTML(t('comparisonNote'))}</p>`;
  }
}
function exportCSV() {
  if (!records.length) return;
  const headers = lang === 'ar' ? ['التاريخ','المصدر','النشاط','الإشارة','الحد النسبي','مهلة التنبيه (ث)','الحساسية','المدة المقررة (ث)','وقت النشاط (ث)','وقت التجاوز (ث)','نسبة التجاوز','عدد التنبيهات','طلبات خفض الصوت','الحالة'] : ['Date','Source','Activité','Signal','Seuil relatif','Délai (s)','Sensibilité','Durée prévue (s)','Temps activité (s)','Dépassement (s)','Dépassement (%)','Alertes','Rappels au calme','État'];
  const rows = records.map(r => [new Date(r.endedAt).toISOString(),t(r.source==='demo'?'demo':'mic'),t(r.config.mode),t(r.config.feedback?'on':'off'),r.config.threshold,r.config.delay,r.config.gain,r.config.duration,r.elapsed.toFixed(2),r.above.toFixed(2),r.percentage.toFixed(2),r.alerts,r.reminders,t(r.complete?'completed':r.reason==='interrupted'?'interrupted':'short')]);
  const csv = '\ufeff'+[headers,...rows].map(row => row.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));
  const a = document.createElement('a');a.href=url;a.download=`HODOU2-${new Date().toISOString().slice(0,10)}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function setProjector(value) {
  projector=value;document.body.classList.toggle('projector',value);$('exitPresentation').hidden=!value;
  if(value)showView('live');
}
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click',()=>showView(button.dataset.view)));
document.querySelector('.tabs').addEventListener('keydown',event=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  const tabs=[...document.querySelectorAll('[data-view]')], i=tabs.findIndex(el=>el===document.activeElement);
  if(i<0)return;event.preventDefault();
  let next = event.key==='Home'?0:event.key==='End'?tabs.length-1:(i+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
  showView(tabs[next].dataset.view);tabs[next].focus();
});
$('languageButton').addEventListener('click',()=>{lang=lang==='ar'?'fr':'ar';writeStore('hodou2.language',lang);applyLanguage();});
$('settingsFieldset').addEventListener('input',event=>{
  if(event.target.name==='activity') $('thresholdInput').value=event.target.value==='group'?'62':'38';
  displayRecord=null;trace=[];updateConfiguration();renderLive();
});
document.querySelectorAll('[data-level]').forEach(button=>button.addEventListener('click',()=>{
  manualLevel=Number(button.dataset.level);$('demoInput').value=manualLevel;$('autoInput').checked=false;setText('demoOutput',number(manualLevel));
  document.querySelectorAll('[data-level]').forEach(el=>el.classList.toggle('active',el===button));
}));
$('demoInput').addEventListener('input',()=>{manualLevel=Number($('demoInput').value);$('autoInput').checked=false;setText('demoOutput',number(manualLevel));document.querySelectorAll('[data-level]').forEach(el=>el.classList.remove('active'));});
$('autoInput').addEventListener('change',()=>{manualLevel=Number($('demoInput').value);document.querySelectorAll('[data-level]').forEach(el=>el.classList.remove('active'));});
$('startButton').addEventListener('click',startSession);
$('cancelStartButton').addEventListener('click',cancelStart);
$('pauseButton').addEventListener('click',pauseSession);$('devicePause').addEventListener('click',pauseSession);
$('stopButton').addEventListener('click',()=>finishSession('manual'));
$('reminderButton').addEventListener('click',()=>{if(engine&&running){engine.reminders++;saveActive();renderLive();}});
$('presentationButton').addEventListener('click',()=>setProjector(true));$('exitPresentation').addEventListener('click',()=>setProjector(false));
$('tryDemoButton').addEventListener('click',()=>{if(!running){document.querySelector('input[name="source"][value="demo"]').checked=true;updateConfiguration();}showView('live');window.scrollTo({top:0,behavior:'smooth'});if(!running)startSession();});
$('exportButton').addEventListener('click',exportCSV);
$('clearButton').addEventListener('click',()=>{$('clearDialog').showModal();});
$('cancelClearButton').addEventListener('click',()=>{$('clearDialog').close();});
$('confirmClearButton').addEventListener('click',()=>{records=[];writeStore(HISTORY_KEY,records);$('clearDialog').close();renderHistory();toast('deleted');});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&projector)setProjector(false);
  if(event.code==='Space'&&running&&!['INPUT','TEXTAREA','BUTTON','SELECT','SUMMARY','A'].includes(document.activeElement.tagName)&&!$('clearDialog').open){event.preventDefault();pauseSession();}
});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&engine&&running&&!engine.paused){engine.pause();saveActive();renderLive();toast('autoPaused');}});
window.addEventListener('pagehide',()=>{saveActive();microphone.stop();});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
const abandoned = readStore(ACTIVE_KEY,null);
if(validRecord(abandoned)&&!records.some(r=>r.id===abandoned.id)){
  abandoned.complete=false;abandoned.reason='interrupted';records=[abandoned,...records].slice(0,100);writeStore(HISTORY_KEY,records);writeStore(ACTIVE_KEY,null);setTimeout(()=>toast('recovered'),300);
}
applyLanguage();requestAnimationFrame(tick);
