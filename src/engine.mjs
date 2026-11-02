export const clamp = (v, low = 0, high = 100) => Math.max(low, Math.min(high, Number(v) || 0));

// All values describe this device's relative input, never calibrated acoustic dB.
export function relativeLevel(samples, gain = 1) {
  if (!samples.length) return 0;
  let sum = 0;
  for (const x of samples) sum += x * x;
  const rms = Math.sqrt(sum / samples.length) * gain;
  return clamp((20 * Math.log10(Math.max(rms, 1e-7)) + 70) / 50 * 100);
}

export class SessionEngine {
  constructor(config) {
    this.config = Object.freeze({ ...config });
    this.elapsed = 0;
    this.above = 0;
    this.pending = 0;
    this.alerts = 0;
    this.reminders = 0;
    this.peak = 0;
    this.paused = false;
    this.finished = false;
    this.signal = 'idle';
    this.level = 0;
  }
  step(level, dt) {
    if (this.finished || this.paused || !Number.isFinite(dt) || dt <= 0) return this;
    const used = Math.min(dt, Math.max(0, this.config.duration - this.elapsed));
    if (!used) { this.finished = true; return this; }
    this.level = clamp(level);
    this.peak = Math.max(this.peak, this.level);
    this.elapsed += used;
    const prev = this.signal;
    if (this.level > this.config.threshold) {
      this.above += used;
      this.pending += used;
      this.signal = this.pending + 1e-8 >= this.config.delay ? 'red' : 'amber';
    } else {
      this.pending = 0;
      this.signal = this.level >= this.config.threshold - 12 ? 'amber' : 'green';
    }
    if (this.signal === 'red' && prev !== 'red') this.alerts++;
    if (this.elapsed + 1e-8 >= this.config.duration) this.finished = true;
    return this;
  }
  pause() { this.paused = true; this.pending = 0; this.signal = 'paused'; }
  resume() { if (!this.finished) { this.paused = false; this.pending = 0; this.signal = 'idle'; } }
  snapshot() {
    return { elapsed: this.elapsed, above: this.above, alerts: this.alerts,
      reminders: this.reminders, peak: this.peak,
      percentage: this.elapsed ? this.above / this.elapsed * 100 : 0 };
  }
}

export function compatibilityKey(config) {
  return JSON.stringify([config.mode, config.threshold, config.delay, config.gain, config.duration]);
}

export function compareSessions(records) {
  // Never treat demonstration records or interrupted runs as classroom evidence.
  const real = records.filter(r => r.source === 'mic' && r.complete && Number.isFinite(r.percentage));
  const sorted = [...real].sort((a, b) => b.endedAt - a.endedAt);
  for (const withFeedback of sorted.filter(r => r.config.feedback)) {
    const baseline = sorted.find(r => !r.config.feedback && compatibilityKey(r.config) === compatibilityKey(withFeedback.config));
    if (baseline) return { baseline, withFeedback, difference: withFeedback.percentage - baseline.percentage };
  }
  return null;
}

export class MicrophoneInput {
  constructor(environment = globalThis) {
    this.environment = environment;
    this.stream = null;
    this.context = null;
    this.analyser = null;
    this.node = null;
    this.generation = 0;
    this.pendingResources = new Map();
  }
  async start() {
    const generation = ++this.generation;
    const env = this.environment;
    if (!env.navigator?.mediaDevices?.getUserMedia) throw Object.assign(new Error('Microphone unavailable'), { name: 'UnavailableError' });
    let stream, context, node, released = false;
    const release = () => {
      if (released) return;
      released = true;
      stream?.getTracks().forEach(t => t.stop());
      try { node?.disconnect(); } catch {}
      try { context?.close()?.catch?.(() => {}); } catch {}
    };
    try {
      stream = await env.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
      if (generation !== this.generation) { stream.getTracks().forEach(t => t.stop()); return false; }
      this.pendingResources.set(generation, release);
      const Audio = env.AudioContext || env.webkitAudioContext;
      if (!Audio) throw Object.assign(new Error('Web Audio unavailable'), { name: 'UnavailableError' });
      context = new Audio();
      await context.resume();
      if (generation !== this.generation) { this.pendingResources.delete(generation); release(); return false; }
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      node = context.createMediaStreamSource(stream);
      node.connect(analyser); // No output connection, recording, or upload.
      this.stream = stream; this.context = context; this.node = node; this.analyser = analyser;
      this.samples = new Float32Array(analyser.fftSize);
      this.pendingResources.delete(generation);
      return true;
    } catch (error) {
      this.pendingResources.delete(generation);
      release();
      throw error;
    }
  }
  read(gain) {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.samples);
    return relativeLevel(this.samples, gain);
  }
  stop() {
    this.generation++;
    this.pendingResources.forEach(release => release());
    this.pendingResources.clear();
    this.stream?.getTracks().forEach(t => t.stop());
    try { this.node?.disconnect(); } catch {}
    const closing = this.context?.close();
    closing?.catch?.(() => {});
    this.stream = this.context = this.analyser = this.node = null;
  }
}
