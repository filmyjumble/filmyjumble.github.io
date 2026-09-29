#!/usr/bin/env node
// Builds www/films.js from TMDB (https://www.themoviedb.org).
// Usage:
//   TMDB_TOKEN=<API Read Access Token> node scripts/fetch-films.mjs
//   (or TMDB_KEY=<v3 API key>)
// Options (env): LANGS=ml,ta,te,hi,en  original languages to include
//                FROM=1950 TO=2026   release-year range
//                CONCURRENCY=8
// Requires Node 18+.

import { writeFileSync, readFileSync, existsSync } from "node:fs";

const TOKEN = process.env.TMDB_TOKEN, KEY = process.env.TMDB_KEY;
if (!TOKEN && !KEY) { console.error("Set TMDB_TOKEN or TMDB_KEY"); process.exit(1); }
const LANGS = (process.env.LANGS || "ml,ta,te,hi,en").split(",").map(s => s.trim());
// Per-language limits: minimum TMDB votes to be considered, and max films kept.
// English has hundreds of thousands of titles, so only reasonably known ones are kept.
const LIMITS = {
  ml: { minVotes: 0, max: 20000 },
  ta: { minVotes: 1, max: 8000 },
  te: { minVotes: 1, max: 8000 },
  hi: { minVotes: 3, max: 8000 },
  en: { minVotes: 250, max: 8000 },
};
const lim = l => LIMITS[l] || { minVotes: 5, max: 5000 };
const FROM = +(process.env.FROM || 1950), TO = +(process.env.TO || new Date().getFullYear());
const CONC = +(process.env.CONCURRENCY || 8);
const BASE = "https://api.themoviedb.org/3";

const OUT = process.env.OUT || "www";
const OVP = process.env.OVERRIDES || "scripts/overrides.json";
// Optional hand fixes: overrides.json  { "rename": { "<tmdbId>": "Title" }, "exclude": ["<tmdbId>"] }
const OV = existsSync(OVP)
  ? JSON.parse(readFileSync(OVP, "utf8")) : { rename: {}, exclude: [] };

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(path, params = {}) {
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (!TOKEN) u.searchParams.set("api_key", KEY);
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(u, { headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {} });
    if (res.status === 429) { await sleep(1000 * (attempt + 1)); continue; }
    if (res.status === 404) return null;
    if (!res.ok) { await sleep(500 * (attempt + 1)); continue; }
    return res.json();
  }
  throw new Error("Failed: " + u.pathname);
}
async function pool(items, fn) {
  const out = []; let i = 0, done = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < items.length) {
      const idx = i++; out[idx] = await fn(items[idx]);
      if (++done % 250 === 0) console.log(`  details ${done}/${items.length}`);
    }
  }));
  return out;
}

// 1. Discover every film, year by year (TMDB caps a query at 500 pages).
const found = new Map();
for (const lang of LANGS) {
  for (let y = FROM; y <= TO; y++) {
    let page = 1, total = 1;
    do {
      const d = await api("/discover/movie", {
        with_original_language: lang, primary_release_year: y,
        include_adult: "false", sort_by: "popularity.desc", page,
        "vote_count.gte": lim(lang).minVotes
      });
      if (!d) break;
      total = Math.min(d.total_pages, 500);
      for (const m of d.results) found.set(m.id, { ...m, lang });
      page++;
    } while (page <= total);
    process.stdout.write(`\r${lang} ${y}: ${found.size} films found`);
  }
}
console.log();

// 2. Credits (director, lead cast) and runtime for each film.
const ids = [...found.keys()].filter(id => !OV.exclude.includes(String(id)));
const details = await pool(ids, async id => {
  const m = await api(`/movie/${id}`, { append_to_response: "credits" });
  return m && { ...m, lang: found.get(id).lang };
});

// 3. Clean titles into playable A–Z words.
function clean(t) {
  return t.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ").replace(/[’'`.!?,]/g, "").replace(/[-–—:;\/]/g, " ").replace(/\s+/g, " ").trim();
}
const byLang = {}; // lang -> Map(titleKey -> {score,row})
let dropped = 0;
for (const m of details) {
  if (!m) { dropped++; continue; }
  const raw = OV.rename[String(m.id)] || m.title || "";
  const t = clean(raw);
  const letters = t.replace(/ /g, "").length;
  const director = (m.credits?.crew || []).filter(c => c.job === "Director").map(c => c.name).slice(0, 2).join(" & ");
  const cast = (m.credits?.cast || []).sort((a, b) => a.order - b.order).slice(0, 2).map(c => c.name).join(", ");
  const year = (m.release_date || "").slice(0, 4);
  const ok = /^[A-Za-z ]+$/.test(t) && letters >= 3 && letters <= 28 && t.split(" ").length <= 5
    && director && cast && year && !m.adult && !(m.runtime && m.runtime < 60);
  if (!ok) { dropped++; continue; }
  const seen = byLang[m.lang] ||= new Map();
  const key = t.toLowerCase();
  const score = (m.vote_count || 0) * 10 + (m.popularity || 0);
  if (seen.has(key) && seen.get(key).score >= score) { dropped++; continue; }
  seen.set(key, { score, row: [t, +year, cast, director, 0] });
}
const out = {}; let total = 0;
for (const lang of LANGS) {
  const list = [...(byLang[lang]?.values() || [])].sort((a, b) => b.score - a.score).slice(0, lim(lang).max);
  out[lang] = list.map((f, i) => (f.row[4] = i + 1, f.row));
  total += out[lang].length;
  console.log(`${lang}: ${out[lang].length} films. Top: ${out[lang].slice(0, 6).map(r => r[0]).join(", ")}`);
}
writeFileSync(`${OUT}/films.js`,
  `// Generated ${new Date().toISOString()} from TMDB. ${total} films.\n` +
  `// This product uses the TMDB API but is not endorsed or certified by TMDB.\n` +
  `window.FILM_DATA=${JSON.stringify(out)};\n`);
writeFileSync(`${OUT}/films-review.json`, JSON.stringify(out, null, 1));
console.log(`Found ${found.size}, kept ${total} playable films, dropped ${dropped}.`);
