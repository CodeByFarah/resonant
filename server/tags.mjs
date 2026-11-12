// Inline tags in text: [pause 1s] works with every voice; emotion and style tags such as
// [whisper] or [excited] steer the Qwen3 preset voices (they become a style instruction) and are
// silently skipped by voices that can't take instructions. A style tag lasts until the next style
// tag or the end of the line; [normal] goes back to the voice's usual style.

const TAG = /\[([^\[\]\n]{1,40})\]/g;
const MAX_PAUSE = 10;

export const STYLES = {
  whisper: "Whispering softly, very quiet and breathy",
  excited: "Excited and energetic, fast and bright",
  happy: "Happy and cheerful, smiling while speaking",
  cheerful: "Cheerful and upbeat",
  sad: "Sad and slow, with a heavy, downcast tone",
  angry: "Angry and intense, forceful",
  calm: "Calm, slow and soothing",
  scared: "Scared and nervous, voice trembling",
  shouting: "Shouting loudly",
  sarcastic: "Sarcastic, dry and mocking",
  serious: "Serious and firm",
  laughing: "Laughing while speaking",
  sighing: "Sighing, weary and tired",
  curious: "Curious and wondering",
  surprised: "Surprised and astonished",
  tired: "Tired and sleepy, slow",
  mysterious: "Low and mysterious, as if telling a secret",
};
const ALIASES = {
  whispers: "whisper", whispering: "whisper", softly: "whisper",
  excitedly: "excited", happily: "happy", sadly: "sad", crying: "sad", angrily: "angry", furious: "angry",
  calmly: "calm", afraid: "scared", fearful: "scared", nervous: "scared", shout: "shouting", shouts: "shouting", yelling: "shouting",
  laughs: "laughing", laugh: "laughing", chuckles: "laughing", sighs: "sighing", sigh: "sighing", surprise: "surprised", sleepy: "tired",
};
const RESET = new Set(["normal", "neutral", "default", "/"]);

function pauseSeconds(tag) {
  const t = tag.toLowerCase().trim();
  if (t === "short pause") return 0.3;
  if (t === "long pause") return 1.5;
  const m = t.match(/^(?:pause|break|silence)(?:\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?)?)?$/);
  if (!m) return null;
  if (!m[1]) return 0.5;
  const v = Number(m[1]) / (m[2] === "ms" ? 1000 : 1);
  return Math.min(MAX_PAUSE, Math.max(0, v));
}
// The instruction a style tag stands for. Unknown tags of two or more words are used as written
// ("[speaking slowly]"); an unknown single word ("[sic]") isn't read and changes nothing (undefined).
// Brackets without letters ("[1]") aren't tags at all (null).
function styleOf(tag) {
  const t = tag.toLowerCase().trim();
  if (!/\p{L}/u.test(t)) return null;
  if (RESET.has(t)) return "";
  const key = ALIASES[t] || t;
  if (STYLES[key]) return STYLES[key];
  return /\s/.test(t) ? t.charAt(0).toUpperCase() + t.slice(1) : undefined;
}

export const hasTags = (text) => /\[[^\[\]\n]{1,40}\]/.test(text || "");

// Splits text into [{ type: "speech", text, style }, { type: "pause", seconds }].
// Brackets without letters ("[1]") are left in the text.
export function parseTags(text) {
  const out = [];
  let style = "";
  const pushText = (s) => {
    for (const piece of s.split(/(\n)/)) {
      if (piece === "\n") { style = ""; continue; } // a style lasts until the end of its line
      const t = piece.replace(/[ \t]+/g, " ");
      if (!t.trim()) continue;
      const last = out.at(-1);
      if (last?.type === "speech" && last.style === style) last.text += (last.text.endsWith(" ") || t.startsWith(" ") ? "" : " ") + t;
      else out.push({ type: "speech", text: t, style });
    }
  };
  let pos = 0;
  for (const m of text.matchAll(TAG)) {
    const pause = pauseSeconds(m[1]);
    const st = pause === null ? styleOf(m[1]) : null;
    if (pause === null && st === null) continue; // not a tag, keep it as text
    pushText(text.slice(pos, m.index));
    pos = m.index + m[0].length;
    if (pause !== null) out.push({ type: "pause", seconds: pause });
    else if (st !== undefined) style = st;
  }
  pushText(text.slice(pos));
  for (const s of out) if (s.type === "speech") s.text = s.text.trim();
  return out.filter((s) => s.type === "pause" || /[\p{L}\p{N}]/u.test(s.text));
}

// Characters that get spoken (tags don't count toward usage).
export const spokenLength = (text) => parseTags(text).reduce((n, s) => n + (s.type === "speech" ? s.text.length : 0), 0);

// ElevenLabs takes pauses as SSML breaks; it can't take our style tags, so those are dropped.
export function toElevenLabs(text, transform = (t) => t) {
  return parseTags(text).map((s) => (s.type === "pause" ? `<break time="${Math.min(3, s.seconds).toFixed(1)}s" />` : transform(s.text))).join(" ");
}
