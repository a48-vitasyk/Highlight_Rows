// Офлайн-генератор WAV-сигналів для сповіщень. Запуск: node tools/gen-sounds.js
// Пише 16-bit mono 44.1kHz WAV у HighlightRows/sounds/ (далі копіюється у Firefox).
const fs = require('fs');
const path = require('path');

const SR = 44100;
const OUT = path.join(__dirname, '..', 'HighlightRows', 'sounds');

function env(t, dur, a, r) {
    if (t < a) return t / a;
    if (t > dur - r) return Math.max(0, (dur - t) / r);
    return 1;
}
function osc(type, phase) {
    if (type === 'square') return Math.sin(phase) >= 0 ? 1 : -1;
    if (type === 'tri') return (2 / Math.PI) * Math.asin(Math.sin(phase));
    return Math.sin(phase);
}
function render(notes) {
    let total = 0;
    notes.forEach((n) => { total = Math.max(total, n.start + n.dur); });
    total += 0.03;
    const N = Math.ceil(total * SR);
    const buf = new Float32Array(N);
    notes.forEach((n) => {
        const vol = n.vol == null ? 0.5 : n.vol;
        const type = n.type || 'sine';
        const a = n.a == null ? 0.006 : n.a;
        const r = n.r == null ? 0.06 : n.r;
        const s0 = Math.floor(n.start * SR);
        const len = Math.floor(n.dur * SR);
        let phase = 0;
        for (let i = 0; i < len; i++) {
            const t = i / SR;
            const f = n.sweepTo ? n.freq + (n.sweepTo - n.freq) * (i / len) : n.freq;
            phase += (2 * Math.PI * f) / SR;
            const idx = s0 + i;
            if (idx < N) buf[idx] += osc(type, phase) * vol * env(t, n.dur, a, r);
        }
    });
    return buf;
}
function writeWav(name, buf) {
    const N = buf.length;
    const d = Buffer.alloc(44 + N * 2);
    d.write('RIFF', 0); d.writeUInt32LE(36 + N * 2, 4); d.write('WAVE', 8);
    d.write('fmt ', 12); d.writeUInt32LE(16, 16); d.writeUInt16LE(1, 20);
    d.writeUInt16LE(1, 22); d.writeUInt32LE(SR, 24); d.writeUInt32LE(SR * 2, 28);
    d.writeUInt16LE(2, 32); d.writeUInt16LE(16, 34);
    d.write('data', 36); d.writeUInt32LE(N * 2, 40);
    for (let i = 0; i < N; i++) {
        const v = Math.max(-1, Math.min(1, buf[i]));
        d.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
    }
    fs.writeFileSync(path.join(OUT, name + '.wav'), d);
    console.log('  ->', name + '.wav', d.length, 'bytes');
}

const beeps = (n, f, on, off, type, vol) => Array.from({ length: n }, (_, i) => ({ start: i * (on + off), dur: on, freq: f, type: type || 'sine', vol: vol == null ? 0.5 : vol }));

const sounds = {
    chime: [{ start: 0, dur: 0.18, freq: 1047, vol: 0.5 }, { start: 0.16, dur: 0.28, freq: 1319, vol: 0.5, r: 0.12 }],
    bell: [{ start: 0, dur: 0.7, freq: 880, vol: 0.5, r: 0.5, a: 0.002 }, { start: 0, dur: 0.7, freq: 1760, vol: 0.18, r: 0.5, a: 0.002 }],
    alarm: beeps(4, 1000, 0.09, 0.06, 'square', 0.4),
    pop: [{ start: 0, dur: 0.07, freq: 660, vol: 0.55, r: 0.05 }],
    marimba: [{ start: 0, dur: 0.13, freq: 523, vol: 0.5 }, { start: 0.1, dur: 0.13, freq: 659, vol: 0.5 }, { start: 0.2, dur: 0.2, freq: 784, vol: 0.5, r: 0.1 }],
    soft: [{ start: 0, dur: 0.45, freq: 440, vol: 0.45, a: 0.05, r: 0.2 }],
    digital: [{ start: 0, dur: 0.07, freq: 1200, vol: 0.4, type: 'square' }, { start: 0.1, dur: 0.07, freq: 1600, vol: 0.4, type: 'square' }],
    triple: beeps(3, 920, 0.1, 0.07, 'sine', 0.5),
    rising: [{ start: 0, dur: 0.32, freq: 400, sweepTo: 1200, vol: 0.5, r: 0.1 }],
    falling: [{ start: 0, dur: 0.32, freq: 1200, sweepTo: 400, vol: 0.5, r: 0.1 }],
    knock: [{ start: 0, dur: 0.09, freq: 160, vol: 0.6, r: 0.07 }, { start: 0.14, dur: 0.09, freq: 160, vol: 0.6, r: 0.07 }],
    bubble: [{ start: 0, dur: 0.14, freq: 600, sweepTo: 950, vol: 0.5, r: 0.08 }],
};

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
console.log('Generating sounds ->', OUT);
Object.keys(sounds).forEach((k) => writeWav(k, render(sounds[k])));
console.log('Done.');
