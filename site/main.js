// Landing page: plays the recorded samples and lights up each word as the voice reaches it.
// Set REPO to the public code address once it exists; until then the install step shows plain text.
const REPO = "";

const SAMPLES = window.SAMPLES || [];
const byId = Object.fromEntries(SAMPLES.map((s) => [s.id, s]));
const still = matchMedia("(prefers-reduced-motion: reduce)");
const audio = new Audio();
audio.preload = "none";
let active = null; // the player that owns the audio element right now

// Turns [text, start, end, isTag] tokens into spans. Consecutive tag tokens ("[pause", "1.5s]")
// become one tag, timed to the gap between the words around it.
function renderWords(container, tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const [text, start, end, isTag] = tokens[i];
    if (isTag) {
      let label = text;
      while (!label.endsWith("]") && tokens[i + 1]?.[3]) label += " " + tokens[++i][0];
      const prev = out.at(-1);
      const next = tokens.slice(i + 1).find((t) => !t[3]);
      out.push({ el: span(label, "tag"), start: prev ? prev.end : 0, end: next ? next[1] : Infinity, tag: true });
    } else {
      out.push({ el: span(text, "w"), start, end });
    }
  }
  out.forEach((w, i) => {
    if (i) container.append(" ");
    container.append(w.el);
  });
  return out;
}
function span(text, cls) {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

class Player {
  constructor(root, button) {
    this.root = root;
    this.button = button;
    this.button.dataset.label = button.getAttribute("aria-label");
    this.words = [];
    this.lines = [];
    button.addEventListener("click", () => this.toggle());
    root.addEventListener("click", (e) => {
      const w = this.words.find((x) => x.el === e.target);
      if (w && !w.tag) this.play(w.start);
    });
  }
  load(sample) {
    if (active === this) stop();
    this.sample = sample;
    const box = this.root.querySelector("[data-words]");
    box.textContent = "";
    this.words = [];
    this.lines = [];
    if (sample.lines) {
      for (const line of sample.lines) {
        const row = document.createElement("p");
        row.className = "line";
        const who = span(line.name, "who");
        const said = document.createElement("span");
        row.append(who, said);
        const ws = renderWords(said, line.words);
        this.lines.push({ el: row, start: ws[0].start, end: ws.at(-1).end });
        this.words.push(...ws);
        box.append(row);
      }
    } else {
      this.words = renderWords(box, sample.words);
    }
    this.paint(-1);
  }
  toggle() {
    if (active === this && !audio.paused) audio.pause();
    else this.play();
  }
  play(at) {
    if (active !== this) {
      if (active) { audio.pause(); active.reset(); }
      active = this;
      audio.src = this.sample.file;
    }
    if (at != null) audio.currentTime = at;
    else if (audio.ended) audio.currentTime = 0;
    audio.play().catch(() => this.reset());
  }
  reset() {
    this.button.classList.remove("playing");
    this.button.setAttribute("aria-label", this.button.dataset.label);
    this.paint(-1);
    this.meter(false);
  }
  // Colours the words already spoken, the current word, and the speaking line in a dialogue.
  // Returns whether a word (not a pause) is being spoken right now.
  paint(t) {
    let speaking = false;
    for (const w of this.words) {
      const now = t >= w.start && t < w.end;
      w.el.classList.toggle("now", now);
      w.el.classList.toggle("said", !w.tag && t >= w.end);
      if (now && !w.tag) speaking = true;
    }
    // A speaker stays highlighted until the next one starts (or briefly after the last line).
    this.lines.forEach((l, i) => l.el.classList.toggle("speaking", t >= l.start && t < (this.lines[i + 1]?.start ?? l.end + 0.25)));
    return speaking;
  }
  meter(speaking) {
    this.button.querySelectorAll(".meter i").forEach((b, i) => {
      const rest = [0.45, 0.75, 1, 0.6][i];
      const level = speaking ? (still.matches ? rest : 0.35 + Math.random() * 0.65) : rest * 0.4;
      b.style.transform = `scaleY(${level.toFixed(2)})`;
    });
  }
}

let raf = 0, lastMeter = 0;
function tick(now) {
  if (!active) return;
  const speaking = active.paint(audio.currentTime);
  if (now - lastMeter > 90) { active.meter(speaking); lastMeter = now; }
  raf = requestAnimationFrame(tick);
}
audio.addEventListener("play", () => {
  if (!active) return;
  active.button.classList.add("playing");
  active.button.setAttribute("aria-label", "Pause");
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
});
audio.addEventListener("pause", () => {
  cancelAnimationFrame(raf);
  if (!active) return;
  active.button.classList.remove("playing");
  active.button.setAttribute("aria-label", active.button.dataset.label);
  active.meter(false);
});
audio.addEventListener("ended", () => { if (active) active.paint(Infinity); });
function stop() {
  audio.pause();
  if (active) active.reset();
  active = null;
}

// Hero reader with a voice picker (a radio group: arrow keys move between voices).
const reader = document.querySelector("[data-reader]");
const voices = SAMPLES.filter((s) => s.words && !s.words.some((w) => w[3]));
const hero = new Player(reader, reader.querySelector("[data-play]"));
const picker = reader.querySelector("[data-voices]");
voices.forEach((s, i) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "voice";
  b.setAttribute("role", "radio");
  const name = span(s.name, "");
  const accent = document.createElement("small");
  accent.textContent = s.accent;
  b.append(name, accent);
  b.addEventListener("click", () => choose(i, true));
  b.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const n = (i + step + voices.length) % voices.length;
    choose(n, true);
    picker.children[n].focus();
  });
  picker.append(b);
});
// The note under the picker says how the chosen voice was made.
const note = reader.querySelector("[data-voice-note]");
const NOTES = {
  builtin: "A built-in voice, recorded on an ordinary laptop with no graphics card. Click any word to jump to it.",
  designed: "Designed from a written description, accent included, on the same laptop. Click any word to jump to it.",
};
function choose(i, autoplay) {
  [...picker.children].forEach((b, j) => { b.setAttribute("aria-checked", String(i === j)); b.tabIndex = i === j ? 0 : -1; });
  note.textContent = NOTES[voices[i].designed ? "designed" : "builtin"];
  hero.load(voices[i]);
  if (autoplay) hero.play(0);
}

// Dialogue and tag examples.
const dialogueRoot = document.querySelector("[data-dialogue]");
const dialogue = new Player(dialogueRoot, dialogueRoot.querySelector("[data-play]"));
const taggedRoot = document.querySelector("[data-tagged]");
const tagged = new Player(taggedRoot, taggedRoot.querySelector("[data-play]"));
if (voices.length) choose(0, false);
if (byId.dialogue) dialogue.load(byId.dialogue);
if (byId.pause) tagged.load(byId.pause);

// Header rule once the page scrolls; repository link once there is one.
const header = document.querySelector(".top");
const onScroll = () => header.classList.toggle("scrolled", scrollY > 8);
addEventListener("scroll", onScroll, { passive: true });
onScroll();
if (REPO) {
  for (const a of document.querySelectorAll("[data-repo]")) { a.href = REPO; a.hidden = false; }
  for (const s of document.querySelectorAll("[data-no-repo]")) s.hidden = true;
}
