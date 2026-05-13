// Procedural combat audio. No external samples: every sound is synthesized
// on demand with the Web Audio API so the project stays self-contained.
//
// Signal flow:
//
//   per-cue layers ──► dry bus ──► saturator ──┐
//                                              ├──► master gain ──► destination
//                  └► wet bus ──► predelay ──► convolver (reverb) ─┘
//
// The dry path passes through a soft-clip waveshaper, giving impacts a
// punchy "everything peaks at once" character without raising the digital
// ceiling. The wet path stays clean so the reverb tail decays smoothly.
// A short pre-delay before the convolver separates the direct hit from
// the room response, making the space feel bigger.

const TYPE = {
  // Per-weapon profile. gain = overall layer level; reverbSend = wet/dry
  // ratio (higher = bigger-feeling space).
  tank: {
    muz: { gain: 1.25, thudF: 75,  dur: 0.32, reverbSend: 0.35 },
    imp: { gain: 1.15, subF:  45,  rumbleDur: 1.10, roarDur: 0.70, reverbSend: 0.55 },
  },
  artillery: {
    muz: { gain: 1.45, thudF: 50,  dur: 0.42, reverbSend: 0.45 },
    imp: { gain: 1.45, subF:  32,  rumbleDur: 1.70, roarDur: 1.05, reverbSend: 0.70 },
  },
  drone: {
    muz: { gain: 0.45, thudF: 180, dur: 0.14, reverbSend: 0.20 },
    imp: { gain: 0.60, subF:  95,  rumbleDur: 0.55, roarDur: 0.32, reverbSend: 0.30 },
  },
  infantry: {
    muz: { gain: 0.55, thudF: 160, dur: 0.12, reverbSend: 0.18 },
    imp: { gain: 0.50, subF: 115,  rumbleDur: 0.40, roarDur: 0.28, reverbSend: 0.25 },
  },
};

let _ctx = null;
let _master = null;
let _dryBus = null;
let _wetBus = null;
let _saturator = null;
let _reverb = null;
let _muted = false;
let _noiseBuf = null;

function ctx() {
  if (_ctx) return _ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  _ctx = new AC();

  _master = _ctx.createGain();
  _master.gain.value = _muted ? 0 : 0.7;

  _saturator = _ctx.createWaveShaper();
  _saturator.curve = saturatorCurve(1.6);
  _saturator.oversample = '4x';

  _dryBus = _ctx.createGain();
  _dryBus.gain.value = 1.0;

  _wetBus = _ctx.createGain();
  _wetBus.gain.value = 0.9;

  const predelay = _ctx.createDelay(0.2);
  predelay.delayTime.value = 0.045;

  _reverb = _ctx.createConvolver();
  _reverb.buffer = buildImpulse(_ctx, 2.2, 3.0);

  // Dry path: saturated for grit
  _dryBus.connect(_saturator);
  _saturator.connect(_master);
  // Wet path: clean reverb tail
  _wetBus.connect(predelay);
  predelay.connect(_reverb);
  _reverb.connect(_master);

  _master.connect(_ctx.destination);
  return _ctx;
}

function buildImpulse(c, duration, decay) {
  const len = Math.floor(c.sampleRate * duration);
  const buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // Decaying noise weighted slightly toward later samples so the
      // tail has a perceptible "wash" rather than dying immediately.
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
    }
  }
  return buf;
}

function saturatorCurve(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return curve;
}

export function unlockAudio() {
  const c = ctx();
  if (c && c.state === 'suspended') c.resume();
}

export function setMuted(v) {
  _muted = !!v;
  if (_master) _master.gain.setTargetAtTime(_muted ? 0 : 0.7, _ctx.currentTime, 0.02);
}

export function isMuted() { return _muted; }

function noiseBuffer(c) {
  if (_noiseBuf) return _noiseBuf;
  const len = Math.floor(c.sampleRate * 2.0);
  _noiseBuf = c.createBuffer(1, len, c.sampleRate);
  const data = _noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return _noiseBuf;
}

// Range [0, 1]: full volume up close, ~0.25 at 75 m, ~0.1 at 200 m.
function distanceGain(srcPos, camera) {
  if (!srcPos || !camera) return 1;
  const dx = srcPos.x - camera.position.x;
  const dy = srcPos.y - camera.position.y;
  const dz = srcPos.z - camera.position.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return 1 / (1 + d / 25);
}

// Build a routing pair: any layer connected to the returned `input` node
// is heard both dry (saturated) and wet (reverb), with `reverbSend`
// controlling the wet-path level.
function cueRouting(c, reverbSend) {
  const input = c.createGain();
  const send = c.createGain();
  send.gain.value = reverbSend;
  input.connect(_dryBus);
  input.connect(send);
  send.connect(_wetBus);
  return input;
}

function shapedNoise(c, t0, peak, attack, dur, filterType, freqStart, freqEnd, out) {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c);
  src.playbackRate.value = 0.85 + Math.random() * 0.3;
  const filt = c.createBiquadFilter();
  filt.type = filterType;
  filt.frequency.setValueAtTime(freqStart, t0);
  if (freqEnd && freqEnd !== freqStart) {
    filt.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t0 + dur);
  }
  if (filterType === 'bandpass') filt.Q.value = 0.7;
  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.linearRampToValueAtTime(peak, t0 + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filt).connect(env).connect(out);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

function shapedSine(c, t0, peak, attack, dur, freqStart, freqEnd, out) {
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freqStart, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(15, freqEnd), t0 + dur);
  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.linearRampToValueAtTime(peak, t0 + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(env).connect(out);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

export function playMuzzle(type, position, camera) {
  const c = ctx();
  if (!c || _muted) return;
  const p = (TYPE[type] ?? TYPE.infantry).muz;
  const t0 = c.currentTime;
  const dg = distanceGain(position, camera);
  const route = cueRouting(c, p.reverbSend);

  // 1) Instant click: very brief HP-noise transient — the "attack"
  shapedNoise(c, t0, 0.9 * p.gain * dg, 0.001, 0.045, 'highpass', 3500, 3500, route);
  // 2) Mid-band crack: the sharp report
  shapedNoise(c, t0, 0.7 * p.gain * dg, 0.003, 0.12,  'bandpass', 1500, 1500, route);
  // 3) Body thud: low sine sweeping down — the chest punch
  shapedSine (c, t0, 0.95 * p.gain * dg, 0.006, p.dur, p.thudF * 2.0, p.thudF * 0.45, route);
  // 4) LP-noise rumble: short tail under the thud (artillery/tank only feel this)
  shapedNoise(c, t0, 0.5 * p.gain * dg, 0.012, p.dur * 1.4, 'lowpass', 600, 120, route);
}

export function playImpact(type, position, camera) {
  const c = ctx();
  if (!c || _muted) return;
  const p = (TYPE[type] ?? TYPE.infantry).imp;
  const t0 = c.currentTime;
  const dg = distanceGain(position, camera);
  const route = cueRouting(c, p.reverbSend);

  // 1) Initial crack: the shell breaking apart / detonation flash
  shapedNoise(c, t0, 0.85 * p.gain * dg, 0.001, 0.09, 'bandpass', 2800, 2800, route);
  // 2) Sub kick: sine sweep from mid-low into very low — the chest hit.
  //    Slightly delayed attack so it "builds" rather than clicks.
  shapedSine (c, t0, 1.20 * p.gain * dg, 0.025, p.rumbleDur, p.subF * 3.0, p.subF * 0.55, route);
  // 3) Low rumble: LP-noise sweeping from bright down to deep — the body of the boom
  shapedNoise(c, t0, 0.85 * p.gain * dg, 0.05, p.rumbleDur, 'lowpass', 1600, 130, route);
  // 4) Mid roar: bandpass noise representing turbulent combustion
  shapedNoise(c, t0, 0.55 * p.gain * dg, 0.035, p.roarDur, 'bandpass', 650, 350, route);
  // 5) Debris hiss: a final high-band scatter that fades after the main body
  shapedNoise(c, t0 + 0.08, 0.3 * p.gain * dg, 0.06, p.rumbleDur * 0.7, 'highpass', 2000, 2000, route);
}
