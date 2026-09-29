// ============================================================
// Sound effects — synthesized with the Web Audio API (no files)
// ============================================================
// iOS Safari blocks audio until the first user gesture, so we lazily create
// the AudioContext inside a click/touch handler.

const sfx = {
  ctx: null,
  enabled: true,

  init() {
    if (this.ctx) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      const saved = localStorage.getItem("impostor-sound");
      if (saved === "0") this.enabled = false;
    } catch (e) {}
  },

  toggle() {
    this.enabled = !this.enabled;
    try { localStorage.setItem("impostor-sound", this.enabled ? "1" : "0"); } catch (e) {}
    if (this.enabled) this.click();
    updateSoundToggleUI();
    return this.enabled;
  },

  isEnabled() { return this.enabled; },

  _tone(freq, dur, type, vol, when) {
    if (!this.enabled || !this.ctx) return;
    if (this.ctx.state === "suspended") { try { this.ctx.resume(); } catch (e) {} }

    const t = this.ctx.currentTime + (when || 0);
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.connect(gain);
    gain.connect(this.ctx.destination);

    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0005, t + dur);

    osc.start(t);
    osc.stop(t + dur + 0.02);
  },

  // Named sound effects
  click()   { this._tone(560, 0.05, "sine", 0.10); },
  tap()     { this._tone(820, 0.04, "triangle", 0.13); },
  step()    { this._tone(680, 0.05, "triangle", 0.13); },
  seg()     { this._tone(920, 0.05, "sine", 0.13); },
  reveal()  {
    this._tone(523, 0.09, "sine", 0.12);
    this._tone(659, 0.09, "sine", 0.12, 0.09);
    this._tone(784, 0.15, "sine", 0.14, 0.18);
  },
  impostor() {
    this._tone(220, 0.15, "sawtooth", 0.09);
    this._tone(180, 0.28, "sawtooth", 0.09, 0.12);
  },
  message() {
    this._tone(900, 0.06, "sine", 0.10);
    this._tone(1250, 0.08, "sine", 0.08, 0.05);
  },
  join() {
    this._tone(659, 0.09, "sine", 0.10);
    this._tone(880, 0.10, "sine", 0.10, 0.09);
  },
  vote()    { this._tone(520, 0.06, "triangle", 0.12); },
  tick()    { this._tone(1000, 0.03, "sine", 0.05); },
  urgent()  { this._tone(1200, 0.05, "square", 0.08); },
  win() {
    this._tone(523, 0.10, "sine", 0.12);
    this._tone(659, 0.10, "sine", 0.12, 0.10);
    this._tone(784, 0.10, "sine", 0.12, 0.20);
    this._tone(1046, 0.30, "sine", 0.14, 0.30);
  },
  lose() {
    this._tone(400, 0.15, "sawtooth", 0.10);
    this._tone(300, 0.20, "sawtooth", 0.10, 0.15);
    this._tone(200, 0.35, "sawtooth", 0.10, 0.32);
  }
};

// Prime the audio context on first user interaction (required for iOS Safari)
["click", "touchstart", "keydown"].forEach((ev) => {
  document.addEventListener(ev, () => sfx.init(), { once: true, capture: true });
});

// Global click sound for every interactive element — distinct per control.
document.addEventListener("click", (e) => {
  const el = e.target.closest("button, .cat-card, .vote-card, .lobby-player, .seg-btn, .stepper-btn, .name-row");
  if (!el) return;
  if (el.id === "sound-toggle") return; // handles its own feedback
  if (el.disabled) return;

  if (el.classList.contains("stepper-btn"))      sfx.step();
  else if (el.classList.contains("seg-btn"))     sfx.seg();
  else if (el.classList.contains("cat-card"))    sfx.tap();
  else if (el.classList.contains("vote-card"))   sfx.tap();
  else                                           sfx.click();
}, true); // capture phase so it fires before per-button handlers

// UI for the mute toggle button (added to index.html)
function updateSoundToggleUI() {
  const btn = document.getElementById("sound-toggle");
  if (!btn) return;
  btn.textContent = sfx.isEnabled() ? "🔊" : "🔇";
  btn.setAttribute("aria-label", sfx.isEnabled() ? "Mute sounds" : "Unmute sounds");
}

document.addEventListener("DOMContentLoaded", () => {
  // Read the persisted preference before any UI shows
  try {
    const saved = localStorage.getItem("impostor-sound");
    if (saved === "0") sfx.enabled = false;
  } catch (e) {}

  const btn = document.getElementById("sound-toggle");
  if (btn) {
    updateSoundToggleUI();
    btn.addEventListener("click", () => sfx.toggle());
  }
});
