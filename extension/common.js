// Shared by the popup, the background worker and the offscreen player.
export const DEFAULTS = { server: "http://localhost:3000", key: "", voice: "af_heart", speed: 1 };
// Resonant's text-to-speech limit per request.
export const MAX_CHARS = 20000;

export async function getSettings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  return { ...s, server: String(s.server || DEFAULTS.server).replace(/\/+$/, "") };
}
export const setSettings = (patch) => chrome.storage.local.set(patch);

export function headers(settings, extra = {}) {
  return { ...(settings.key ? { "xi-api-key": settings.key } : {}), ...extra };
}

// What the player is doing, kept in session storage so the popup can show it.
export const getStatus = async () => (await chrome.storage.session.get({ status: { state: "idle" } })).status;
export const setStatus = (status) => chrome.storage.session.set({ status });

// Runs inside the web page (injected with chrome.scripting), so it must not use anything from
// outside this function. Returns the selected text, or the readable text of the page: the article
// or main content, without menus, headers, footers, scripts and forms.
export function extractText() {
  const selection = String(getSelection?.() || "").trim();
  if (selection.length > 1) return { text: selection, source: "selection", title: document.title };
  const root = document.querySelector("article") || document.querySelector("main, [role=main]") || document.body;
  const clone = root.cloneNode(true);
  clone.querySelectorAll([
    "script", "style", "noscript", "template", "svg", "canvas", "iframe", "form", "button", "input", "select", "textarea",
    "nav", "header", "footer", "aside", "figure", "[role=navigation]", "[role=banner]", "[role=contentinfo]", "[role=complementary]",
    "[aria-hidden=true]", "[hidden]", ".sr-only", ".visually-hidden",
  ].join(",")).forEach((n) => n.remove());
  const BLOCKS = "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,dd,dt,td,th,figcaption";
  const clean = (s) => s.replace(/\s+/g, " ").trim();
  let parts = [...clone.querySelectorAll(BLOCKS)]
    .filter((n) => !n.parentElement?.closest(BLOCKS)) // a <p> inside a <li> is read once
    .map((n) => {
      const t = clean(n.textContent || "");
      // Headings and list items without end punctuation get a full stop, so the voice pauses.
      return t && /^(H\d|LI|DT|TD|TH)$/.test(n.tagName) && !/[.!?:;…]$/.test(t) ? `${t}.` : t;
    })
    .filter((t) => t.length > 1);
  if (!parts.join("").length) parts = [clean(clone.textContent || "")];
  const title = clean(document.title || "");
  let text = parts.join("\n\n");
  // Start with the page title unless the content already does.
  if (title && !text.slice(0, 300).toLowerCase().includes(title.toLowerCase().slice(0, 40))) text = `${title}.\n\n${text}`;
  return { text, source: "page", title };
}
