// index.js
// Stremio subtitle translate addon — OpenSubtitles priority + full-batch translation + placeholder + cache
// Supports translation engines: google_free, google_cloud, deepl
// Env:
//  PORT (default 3000)
//  BASE_URL (optional, for manifest links)
//  OPENSUBTITLES_API_KEY (required to use OpenSubtitles)
//  GOOGLE_API_KEY (optional for google_cloud)
//  DEEPL_API_KEY (optional for deepl)
//  ENGINE (default google_free)
//  DEFAULT_TO (default zh-CN)

import express from 'express';
import axios from 'axios';
import Bottleneck from 'bottleneck';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { addonBuilder } from 'stremio-addon-sdk';
import crypto from 'crypto';
import os from 'os';
import fs from 'fs';
import path from 'path';

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const OPENSUBTITLES_API_KEY = process.env.OPENSUBTITLES_API_KEY || '';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const DEEPL_API_KEY = process.env.DEEPL_API_KEY || '';
const ENGINE = process.env.ENGINE || 'google_free'; // google_free | google_cloud | deepl
const DEFAULT_TO = process.env.DEFAULT_TO || 'zh-CN';

// rate limiter for external calls
const limiter = new Bottleneck({ minTime: 300, maxConcurrent: 1 });

// data dir & sqlite init
const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'cache.sqlite');

let db;
async function initDB() {
  db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS opensub_cache (
      key TEXT PRIMARY KEY,
      subtitle_url TEXT,
      fetched_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS translation_cache (
      key TEXT PRIMARY KEY,
      to_lang TEXT,
      engine TEXT,
      source_hash TEXT,
      srt TEXT,
      status TEXT, -- pending|done|error
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      key TEXT,
      status TEXT,
      message TEXT,
      updated_at INTEGER
    );
  `);
}

// helpers
function hashStr(s) {
  return crypto.createHash('sha1').update(s || '').digest('hex');
}
function srtTimeToMs(t) {
  // "00:02:15,120"
  const m = t.match(/(\d+):(\d{2}):(\d{2}),(\d{3})/);
  if (!m) return 0;
  return (+m[1]) * 3600 * 1000 + (+m[2]) * 60 * 1000 + (+m[3]) * 1000 + (+m[4]);
}
function parseSRT(s) {
  // very tolerant parser
  const blocks = [];
  const parts = s.split(/\r?\n\r?\n/);
  for (const p of parts) {
    const lines = p.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) continue;
    // find time line
    let timeLineIndex = lines.findIndex(l => /-->/i.test(l));
    if (timeLineIndex === -1) continue;
    const id = lines.slice(0, timeLineIndex).join(' ').trim();
    const timeLine = lines[timeLineIndex].trim();
    const text = lines.slice(timeLineIndex + 1).join('\n').trim();
    const [start, end] = timeLine.split('-->').map(x => x.trim());
    blocks.push({ id: id || '', start, end, startMs: srtTimeToMs(start), text });
  }
  return blocks;
}
function buildSRT(blocks) {
  return blocks.map((b, i) => {
    const id = b.id || (i + 1);
    return `${id}\n${b.start} --> ${b.end}\n${b.text}\n`;
  }).join('\n');
}
function makePlaceholderSRT(note, lang = 'en') {
  // one short subtitle lasting 30s at start
  const text = note.replace(/\n/g, ' ');
  return `1\n00:00:00,000 --> 00:00:30,000\n${text}\n`;
}

// OpenSubtitles search (prefer given language)
async function searchOpenSubtitles(imdb_id, season, episode, lang = 'en') {
  if (!OPENSUBTITLES_API_KEY) throw new Error('OPENSUBTITLES_API_KEY not configured');
  const key = `${imdb_id}|${season||''}|${episode||''}|${lang}`;
  // cache 6h
  const cached = await db.get('SELECT subtitle_url,fetched_at FROM opensub_cache WHERE key=?', key);
  if (cached && (Date.now() - cached.fetched_at) < 1000 * 60 * 60 * 6) return cached.subtitle_url;
  const url = 'https://api.opensubtitles.com/api/v1/subtitles';
  const params = { imdb_id: imdb_id.replace(/^tt/,'') ? imdb_id : imdb_id, languages: lang };
  if (season) params.season_number = season;
  if (episode) params.episode_number = episode;
  params.order_by = 'downloads'; params.sort = 'desc';
  const res = await limiter.schedule(() => axios.get(url, {
    params,
    headers: { 'Api-Key': OPENSUBTITLES_API_KEY, 'Accept': 'application/json' },
    timeout: 15000,
  }));
  const items = (res.data && res.data.data) || [];
  if (!items.length) return null;
  // pick first with files
  let chosen = null;
  for (const it of items) {
    if (it.attributes && Array.isArray(it.attributes.files) && it.attributes.files.length) {
      chosen = it;
      break;
    }
  }
  if (!chosen) return null;
  const file = chosen.attributes.files[0];
  const file_id = file.file_id;
  const dlRes = await limiter.schedule(() => axios.post('https://api.opensubtitles.com/api/v1/download', { file_id }, {
    headers: { 'Api-Key': OPENSUBTITLES_API_KEY, 'Content-Type': 'application/json' },
    timeout: 15000,
  }));
  const link = dlRes.data && (dlRes.data.link || (dlRes.data.data && dlRes.data.data.link));
  if (!link) return null;
  await db.run('INSERT OR REPLACE INTO opensub_cache(key,subtitle_url,fetched_at) VALUES(?,?,?)', key, link, Date.now());
  return link;
}

async function downloadText(url) {
  const res = await limiter.schedule(() => axios.get(url, { responseType: 'text', timeout: 20000, headers: { 'User-Agent': 'Mozilla/5.0' } }));
  return res.data;
}

// Translation engines
async function googleFreeTranslate(text, to) {
  const url = 'https://translate.googleapis.com/translate_a/single';
  const params = { client: 'gtx', sl: 'auto', tl: to, dt: 't', q: text };
  const res = await limiter.schedule(() => axios.get(url, { params, timeout: 15000 }));
  const data = res.data;
  if (!data) return '';
  const arr = data[0] || [];
  return arr.map(x => (x && x[0]) || '').join('');
}
async function googleCloudTranslate(arrayTexts, to) {
  if (!GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY not configured');
  const url = `https://translation.googleapis.com/language/translate/v2`;
  const res = await limiter.schedule(() => axios.post(url, {
    q: arrayTexts,
    target: to,
    format: 'text',
  }, { params: { key: GOOGLE_API_KEY }, timeout: 20000 }));
  const translations = (res.data && res.data.data && res.data.data.translations) || [];
  return translations.map(t => t.translatedText || '');
}
async function deepLTranslate(arrayTexts, to) {
  if (!DEEPL_API_KEY) throw new Error('DEEPL_API_KEY not configured');
  const url = `https://api-free.deepl.com/v2/translate`; // free account endpoint; enterprise may differ
  // DeepL supports multiple text params 'text=...' in form-urlencoded
  const form = new URLSearchParams();
  for (const t of arrayTexts) form.append('text', t);
  form.append('target_lang', to.replace('-','').slice(0,2).toUpperCase()); // rough mapping zh-CN -> ZH etc
  const res = await limiter.schedule(() => axios.post(url, form.toString(), {
    headers: { 'Authorization': `DeepL-Auth-Key ${DEEPL_API_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000,
  }));
  const translations = (res.data && res.data.translations) || [];
  return translations.map(t => t.text || '');
}

// batch-translate utility (chunks & cache)
async function batchTranslateSentences(sentences, to, engine) {
  // sentences: array of strings
  // engine: google_free | google_cloud | deepl
  // returns array of translated strings same length (best effort)
  const results = new Array(sentences.length).fill('');
  // simple per-job cache key per sentence could be added; for simplicity we cache final SRT only
  // chunk into batches by maxChars
  const maxChars = 4000;
  let batch = [], idxBatch = [], len = 0;
  async function flush() {
    if (!batch.length) return;
    try {
      let outArr = [];
      if (engine === 'google_cloud') outArr = await googleCloudTranslate(batch, to);
      else if (engine === 'deepl') outArr = await deepLTranslate(batch, to);
      else {
        // google_free: join with \n and split heuristically
        const joined = await googleFreeTranslate(batch.join('\n'), to);
        // try split by newline
        outArr = joined.split('\n');
        if (outArr.length !== batch.length) {
          // fallback: try to split proportionally
          const avg = Math.max(1, Math.floor(joined.length / batch.length));
          outArr = [];
          let p = 0;
          for (let i = 0; i < batch.length; i++) {
            const part = joined.slice(p, p + avg);
            outArr.push(part);
            p += avg;
          }
          // ensure lengths match
          if (outArr.length < batch.length) {
            while (outArr.length < batch.length) outArr.push('');
          } else if (outArr.length > batch.length) outArr = outArr.slice(0, batch.length);
        }
      }
      for (let i = 0; i < idxBatch.length; i++) {
        results[idxBatch[i]] = outArr[i] || '';
      }
    } catch (e) {
      // on translate error, leave blanks
      console.error('batch translate error', e && e.message ? e.message : e);
    }
    batch = []; idxBatch = []; len = 0;
  }
  for (let i = 0; i < sentences.length; i++) {
    const s = (sentences[i] || '').trim();
    if (!s) { results[i] = ''; continue; }
    if (len + s.length + 1 > maxChars && batch.length) {
      await flush();
    }
    batch.push(s);
    idxBatch.push(i);
    len += s.length + 1;
  }
  await flush();
  return results;
}

// job submit / do
async function submitTranslationJob(key, imdb_id, season, episode, subtitleText, to, engine) {
  const jobId = hashStr(key + Date.now());
  await db.run('INSERT OR REPLACE INTO jobs(id,key,status,updated_at) VALUES(?,?,?,?)', jobId, key, 'pending', Date.now());
  // do async but not await here
  (async () => {
    try {
      await db.run('UPDATE jobs SET status=?,updated_at=? WHERE id=?', 'running', Date.now(), jobId);
      const blocks = parseSRT(subtitleText);
      const texts = blocks.map(b => b.text);
      const translated = await batchTranslateSentences(texts, to, engine);
      const outBlocks = blocks.map((b, i) => {
        return { ...b, text: translated[i] ? `${translated[i]}` : b.text };
      });
      const finalSrt = buildSRT(outBlocks);
      await db.run('INSERT OR REPLACE INTO translation_cache(key,to_lang,engine,source_hash,srt,status,created_at) VALUES(?,?,?,?,?,?,?)',
        key, to, engine, hashStr(subtitleText), finalSrt, 'done', Date.now());
      await db.run('UPDATE jobs SET status=?,message=?,updated_at=? WHERE id=?', 'done', 'completed', Date.now(), jobId);
    } catch (e) {
      console.error('job failed', e && e.message ? e.message : e);
      await db.run('INSERT OR REPLACE INTO translation_cache(key,to_lang,engine,source_hash,srt,status,created_at) VALUES(?,?,?,?,?,?,?)',
        key, to, engine, '', '', 'error', Date.now());
      await db.run('UPDATE jobs SET status=?,message=?,updated_at=? WHERE id=?', 'error', String(e && e.message ? e.message : e), Date.now(), jobId);
    }
  })();
  return jobId;
}

// main express app
await initDB();
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// simple home
app.get('/', (req, res) => {
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end(`<h2>Subtitle Translate Addon (OpenSubtitles priority)</h2>
    <p>Use <code>${BASE_URL}/manifest.json</code> to add to Stremio.</p>
    <p>Translate endpoint examples:</p>
    <ul>
      <li>/translate?imdb_id=tt0944947&season=1&episode=1&to=zh-CN</li>
      <li>/translate?source=https://.../sub.srt&to=zh-CN</li>
    </ul>`);
});

// status endpoint
app.get('/status/:jobId', async (req, res) => {
  const job = await db.get('SELECT * FROM jobs WHERE id=?', req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
});

// manifest for Stremio
const manifest = {
  id: 'org.custom.subtranslate.opensub',
  version: '1.0.0',
  name: 'Subtitle Translate (OpenSubtitles priority)',
  description: 'Search OpenSubtitles for target language first; if missing, translate English subtitles and cache.',
  resources: ['subtitles'],
  types: ['movie','series'],
  idPrefixes: ['tt'],
  behaviorHints: { configurable: true, configurationRequired: false },
  config: [
    { key: 'to', title: 'Target language (e.g. zh-CN)', type: 'text', default: DEFAULT_TO },
    { key: 'engine', title: 'Engine', type: 'text', default: ENGINE }
  ],
  // 修复了 manifest.catalogs 错误
  catalogs: []
};
const builder = new addonBuilder(manifest);
app.get('/manifest.json', (req, res) => res.json(builder.getInterface().manifest));

// core translate route
app.get('/translate', async (req, res) => {
  try {
    const { imdb_id, season, episode, source } = req.query;
    const to = (req.query.to || DEFAULT_TO);
    const engine = (req.query.engine || ENGINE);

    if (!imdb_id && !source) return res.status(400).json({ error: 'missing imdb_id or source' });

    // build key for cache: imdb|season|episode|to|engine
    const keyBase = imdb_id ? `${imdb_id}|${season||''}|${episode||''}` : `source|${source}`;
    const cacheKey = `${keyBase}|${to}|${engine}`;

    // check cache
    const cached = await db.get('SELECT * FROM translation_cache WHERE key=?', cacheKey);
    if (cached && cached.status === 'done' && cached.srt) {
      return res.setHeader('Content-Type','application/x-subrip; charset=utf-8').send(cached.srt);
    }

    // 1) if imdb_id: try to find target language subtitle first
    let subtitleUrl = null;
    let originalText = null;
    if (imdb_id) {
      // try target language (simplify to first two-letter mapping)
      const langTry = to.split('-')[0]; // zh-CN -> zh
      try {
        subtitleUrl = await searchOpenSubtitles(imdb_id, season, episode, langTry);
      } catch (e) {
        console.warn('opensub target search error', e && e.message ? e.message : e);
      }
      if (subtitleUrl) {
        // got target language subtitle -> return it directly (no translation)
        originalText = await downloadText(subtitleUrl);
        // store into cache as done
        await db.run('INSERT OR REPLACE INTO translation_cache(key,to_lang,engine,source_hash,srt,status,created_at) VALUES(?,?,?,?,?,?,?)',
          cacheKey, to, engine, hashStr(originalText), originalText, 'done', Date.now());
        return res.setHeader('Content-Type','application/x-subrip; charset=utf-8').send(originalText);
      }
      // else fallback to english
      try {
        subtitleUrl = await searchOpenSubtitles(imdb_id, season, episode, 'en');
      } catch (e) {
        console.warn('opensub en search error', e && e.message ? e.message : e);
        subtitleUrl = null;
      }
      if (!subtitleUrl) {
        return res.status(404).json({ error: 'no subtitles found on OpenSubtitles' });
      }
      originalText = await downloadText(subtitleUrl);
    } else {
      // source provided direct
      originalText = await downloadText(source);
    }

    // we now have originalText (likely english)
    // if no cache, create placeholder and start translation job
    // first write placeholder cache with status pending to avoid duplicate jobs
    await db.run('INSERT OR REPLACE INTO translation_cache(key,to_lang,engine,source_hash,srt,status,created_at) VALUES(?,?,?,?,?,?,?)',
      cacheKey, to, engine, hashStr(originalText), '', 'pending', Date.now());

    // start background job to translate full file
    const jobId = await submitTranslationJob(cacheKey, imdb_id, season, episode, originalText, to, engine);

    // respond immediately with placeholder SRT that instructs user to reselect after ~30s
    const note = `Translating subtitles to ${to} (engine=${engine}). Job id=${jobId}. Please re-open subtitle list after ~20-60s to load completed translation.`;
    const placeholder = makePlaceholderSRT(note);
    res.setHeader('Content-Type','application/x-subrip; charset=utf-8');
    res.send(placeholder);

  } catch (e) {
    console.error(e && e.message ? e.message : e);
    res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
});

app.listen(PORT, () => console.log(`Subtitle translate addon running at ${BASE_URL}:${PORT}`));
