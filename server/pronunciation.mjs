// Pronunciation dictionary: words and names the voices should say differently, written the way
// they should sound ("Nguyen" -> "win", "SQL" -> "sequel"). Rules rewrite the text just before it
// reaches a voice, everywhere: Text to Speech, Dialogue, Studio and the API. History keeps the
// original text.
import * as dbm from "./db.mjs";
import { httpError } from "./audio.mjs";

const db = dbm.database;
const MAX_WORD = 100;
const MAX_ALIAS = 200;
const MAX_RULES = 2000;

db.exec(`
  CREATE TABLE IF NOT EXISTS pronunciation_rules (
    rule_id TEXT PRIMARY KEY,
    word TEXT NOT NULL,
    alias TEXT NOT NULL,
    case_sensitive INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_unix INTEGER NOT NULL
  );
`);

const shape = (r) => ({ rule_id: r.rule_id, word: r.word, alias: r.alias, case_sensitive: Boolean(r.case_sensitive), enabled: Boolean(r.enabled), created_unix: r.created_unix });
export const listRules = () => db.prepare("SELECT * FROM pronunciation_rules ORDER BY word COLLATE NOCASE").all().map(shape);
const getRule = (id) => db.prepare("SELECT * FROM pronunciation_rules WHERE rule_id = ?").get(id);

// ---------- applying ----------
// One pass over the text with every word in a single regex, longest first, so a replacement is
// never rewritten again by another rule and "New York City" wins over "New York".
let compiled = null;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function compile() {
  const rules = listRules().filter((r) => r.enabled);
  if (!rules.length) return { re: null };
  const exact = new Map(), loose = new Map();
  for (const r of rules) {
    if (r.case_sensitive) exact.set(r.word, r.alias);
    else loose.set(r.word.toLowerCase(), r.alias);
  }
  const words = [...new Set(rules.map((r) => r.word))].sort((a, b) => b.length - a.length);
  // Whole words only: no letter or digit right before or after the match.
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${words.map(escapeRe).join("|")})(?![\\p{L}\\p{N}_])`, "giu");
  return { re, exact, loose };
}
export function apply(text) {
  if (!compiled) compiled = compile();
  const { re, exact, loose } = compiled;
  if (!re || !text) return text;
  return text.replace(re, (m) => exact.get(m) ?? loose.get(m.toLowerCase()) ?? m);
}
const changed = () => { compiled = null; };

// ---------- validation ----------
function clean(body, partial = false) {
  const out = {};
  if (!partial || "word" in body) {
    const word = String(body.word ?? "").replace(/\s+/g, " ").trim();
    if (!word) throw httpError(422, "word is required");
    if (word.length > MAX_WORD) throw httpError(422, `word can be at most ${MAX_WORD} characters`);
    if (!/[\p{L}\p{N}]/u.test(word)) throw httpError(422, "word needs at least one letter or number");
    out.word = word;
  }
  if (!partial || "alias" in body) {
    const alias = String(body.alias ?? "").replace(/\s+/g, " ").trim();
    if (!alias) throw httpError(422, "alias is required: write the word the way it should sound");
    if (alias.length > MAX_ALIAS) throw httpError(422, `alias can be at most ${MAX_ALIAS} characters`);
    out.alias = alias;
  }
  if ("case_sensitive" in body) out.case_sensitive = body.case_sensitive ? 1 : 0;
  if ("enabled" in body) out.enabled = body.enabled ? 1 : 0;
  return out;
}
// Two rules clash when they would match the same text.
function duplicate(word, caseSensitive, exceptId = null) {
  return db.prepare("SELECT rule_id, word, case_sensitive FROM pronunciation_rules WHERE rule_id IS NOT ?").all(exceptId)
    .find((r) => (r.case_sensitive && caseSensitive ? r.word === word : r.word.toLowerCase() === word.toLowerCase()));
}
function insert(r) {
  const id = dbm.newId();
  db.prepare("INSERT INTO pronunciation_rules (rule_id, word, alias, case_sensitive, enabled, created_unix) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, r.word, r.alias, r.case_sensitive ?? 0, r.enabled ?? 1, dbm.now());
  return id;
}
const count = () => db.prepare("SELECT COUNT(*) AS n FROM pronunciation_rules").get().n;

export function registerPronunciation({ route, readJson, json }) {
  route("GET", "/api/pronunciation", async (req, res) => json(res, 200, { rules: listRules() }));

  route("POST", "/api/pronunciation", async (req, res) => {
    const r = clean(await readJson(req));
    if (count() >= MAX_RULES) throw httpError(422, `The dictionary holds at most ${MAX_RULES} words`);
    const dup = duplicate(r.word, Boolean(r.case_sensitive));
    if (dup) throw httpError(409, `"${dup.word}" is already in the dictionary`);
    const id = insert(r);
    changed();
    json(res, 200, shape(getRule(id)));
  });

  route("PATCH", "/api/pronunciation/:id", async (req, res, p) => {
    const cur = getRule(p.id);
    if (!cur) throw httpError(404, "Rule not found");
    const next = { ...cur, ...clean(await readJson(req), true) };
    const dup = duplicate(next.word, Boolean(next.case_sensitive), cur.rule_id);
    if (dup) throw httpError(409, `"${dup.word}" is already in the dictionary`);
    db.prepare("UPDATE pronunciation_rules SET word = ?, alias = ?, case_sensitive = ?, enabled = ? WHERE rule_id = ?")
      .run(next.word, next.alias, next.case_sensitive, next.enabled, cur.rule_id);
    changed();
    json(res, 200, shape(getRule(cur.rule_id)));
  });

  route("DELETE", "/api/pronunciation/:id", async (req, res, p) => {
    if (!getRule(p.id)) throw httpError(404, "Rule not found");
    db.prepare("DELETE FROM pronunciation_rules WHERE rule_id = ?").run(p.id);
    changed();
    json(res, 200, { status: "ok" });
  });

  // Adds many rules at once (from an exported file). Words already in the dictionary are updated.
  route("POST", "/api/pronunciation/import", async (req, res) => {
    const body = await readJson(req);
    if (!Array.isArray(body.rules)) throw httpError(422, "Expected { rules: [{ word, alias }] }");
    let added = 0, updated = 0;
    const errors = [];
    db.exec("BEGIN");
    try {
      body.rules.slice(0, MAX_RULES).forEach((row, i) => {
        let r;
        try { r = clean(row || {}); } catch (e) { errors.push(`Row ${i + 1}: ${e.message}`); return; }
        const dup = duplicate(r.word, Boolean(r.case_sensitive));
        if (dup) {
          db.prepare("UPDATE pronunciation_rules SET alias = ?, case_sensitive = ?, enabled = ? WHERE rule_id = ?")
            .run(r.alias, r.case_sensitive ?? dup.case_sensitive, r.enabled ?? 1, dup.rule_id);
          updated++;
        } else if (count() < MAX_RULES) { insert(r); added++; }
      });
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    changed();
    json(res, 200, { added, updated, errors: errors.slice(0, 20) });
  });

  // What a text becomes after the dictionary, for previews in the app.
  route("POST", "/api/pronunciation/apply", async (req, res) => {
    const body = await readJson(req);
    json(res, 200, { text: apply(String(body.text ?? "").slice(0, 20000)) });
  });
}
