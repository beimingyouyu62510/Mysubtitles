// index.js - 优化版本
// Stremio subtitle translate addon - 优化版本
// 修复了配置获取、字幕处理、用户体验等问题

import express from 'express';
import axios from 'axios';
import Bottleneck from 'bottleneck';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { addonBuilder } from 'stremio-addon-sdk';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const OPENSUBTITLES_API_KEY = process.env.OPENSUBTITLES_API_KEY || '';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const DEEPL_API_KEY = process.env.DEEPL_API_KEY || '';
const ENGINE = process.env.ENGINE || 'google_free';
const DEFAULT_TO_LANGS = (process.env.DEFAULT_TO_LANGS || 'zh-CN,ja,ko,es,fr').split(',');

// rate limiter for external calls
const limiter = new Bottleneck({ minTime: 500, maxConcurrent: 2 });

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
      subtitle_content TEXT,
      fetched_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS translation_cache (
      key TEXT PRIMARY KEY,
      to_lang TEXT,
      engine TEXT,
      source_hash TEXT,
      srt_content TEXT,
      status TEXT, -- pending|done|error
      progress INTEGER DEFAULT 0,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_translation_status ON translation_cache(status, created_at);
  `);
}

// helpers
function hashStr(s) {
  return crypto.createHash('sha1').update(s || '').digest('hex');
}

function srtTimeToMs(t) {
  const m = t.match(/(\d+):(\d{2}):(\d{2}),(\d{3})/);
  if (!m) return 0;
  return (+m[1]) * 3600 * 1000 + (+m[2]) * 60 * 1000 + (+m[3]) * 1000 + (+m[4]);
}

function parseSRT(s) {
  const blocks = [];
  const parts = s.split(/\r?\n\r?\n/);
  for (const p of parts) {
    const lines = p.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) continue;
    let timeLineIndex = lines.findIndex(l => /-->/i.test(l));
    if (timeLineIndex === -1) continue;
    const id = lines.slice(0, timeLineIndex).join(' ').trim();
    const timeLine = lines[timeLineIndex].trim();
    const text = lines.slice(timeLineIndex + 1).join('\n').trim();
    const [start, end] = timeLine.split('-->').map(x => x.trim());
    blocks.push({ 
      id: id || '', 
      start, 
      end, 
      startMs: srtTimeToMs(start), 
      text 
    });
  }
  return blocks.sort((a, b) => a.startMs - b.startMs);
}

function buildSRT(blocks) {
  return blocks.map((b, i) => {
    const id = b.id || (i + 1);
    return `${id}\n${b.start} --> ${b.end}\n${b.text}\n`;
  }).join('\n');
}

// OpenSubtitles search with content caching
async function searchAndCacheOpenSubtitles(imdb_id, season, episode, lang = 'en') {
  console.log(`Searching OpenSubtitles: ${imdb_id}, S${season}E${episode}, lang=${lang}`);
  
  if (!OPENSUBTITLES_API_KEY) {
    throw new Error('OPENSUBTITLES_API_KEY not configured');
  }

  const key = `${imdb_id}|${season||''}|${episode||''}|${lang}`;
  
  // Check cache (24h validity)
  const cached = await db.get('SELECT subtitle_content, fetched_at FROM opensub_cache WHERE key=?', key);
  if (cached && (Date.now() - cached.fetched_at) < 1000 * 60 * 60 * 24) {
    console.log(`Cache hit for OpenSubtitles: ${key}`);
    return cached.subtitle_content;
  }

  // Search subtitles
  const searchUrl = 'https://api.opensubtitles.com/api/v1/subtitles';
  const params = { 
    imdb_id, 
    languages: lang,
    order_by: 'downloads',
    sort: 'desc'
  };
  if (season) params.season_number = season;
  if (episode) params.episode_number = episode;

  const searchRes = await limiter.schedule(() => axios.get(searchUrl, {
    params,
    headers: { 
      'Api-Key': OPENSUBTITLES_API_KEY, 
      'Accept': 'application/json',
      'User-Agent': 'Stremio Subtitle Addon v2.0'
    },
    timeout: 15000,
  }));

  const items = (searchRes.data?.data) || [];
  if (!items.length) {
    console.log(`No subtitles found for ${lang}`);
    return null;
  }

  // Find suitable file
  let chosen = null;
  for (const item of items) {
    if (item.attributes?.files?.length) {
      chosen = item;
      break;
    }
  }

  if (!chosen) {
    console.log(`No suitable files found`);
    return null;
  }

  // Download subtitle
  const file_id = chosen.attributes.files[0].file_id;
  const downloadRes = await limiter.schedule(() => axios.post(
    'https://api.opensubtitles.com/api/v1/download', 
    { file_id }, 
    {
      headers: { 
        'Api-Key': OPENSUBTITLES_API_KEY, 
        'Content-Type': 'application/json',
        'User-Agent': 'Stremio Subtitle Addon v2.0'
      },
      timeout: 15000,
    }
  ));

  const downloadLink = downloadRes.data?.link;
  if (!downloadLink) {
    throw new Error('Failed to get download link');
  }

  // Fetch subtitle content
  const contentRes = await limiter.schedule(() => axios.get(downloadLink, {
    responseType: 'text',
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  }));

  const content = contentRes.data;
  
  // Cache content
  await db.run('INSERT OR REPLACE INTO opensub_cache(key, subtitle_content, fetched_at) VALUES(?,?,?)', 
    key, content, Date.now());
  
  console.log(`Successfully fetched and cached subtitles for ${key}`);
  return content;
}

// Translation engines
async function translateTexts(texts, toLang, engine) {
  if (!texts.length) return [];
  
  try {
    switch (engine) {
      case 'google_cloud':
        return await googleCloudTranslate(texts, toLang);
      case 'deepl':
        return await deepLTranslate(texts, toLang);
      default:
        return await googleFreeTranslate(texts, toLang);
    }
  } catch (error) {
    console.error(`Translation failed with ${engine}:`, error.message);
    throw error;
  }
}

async function googleFreeTranslate(texts, to) {
  const results = [];
  // Process in chunks to avoid rate limits
  const chunkSize = 10;
  for (let i = 0; i < texts.length; i += chunkSize) {
    const chunk = texts.slice(i, i + chunkSize);
    const combined = chunk.join('\n---SPLIT---\n');
    
    const res = await limiter.schedule(() => axios.get('https://translate.googleapis.com/translate_a/single', {
      params: { client: 'gtx', sl: 'auto', tl: to, dt: 't', q: combined },
      timeout: 20000
    }));
    
    const translated = res.data?.[0]?.map(x => x?.[0]).join('') || '';
    const splits = translated.split('\n---SPLIT---\n');
    
    // Pad with originals if translation incomplete
    for (let j = 0; j < chunk.length; j++) {
      results.push(splits[j] || chunk[j] || '');
    }
  }
  return results;
}

async function googleCloudTranslate(texts, to) {
  if (!GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY required');
  
  const res = await limiter.schedule(() => axios.post(
    'https://translation.googleapis.com/language/translate/v2',
    { q: texts, target: to, format: 'text' },
    { 
      params: { key: GOOGLE_API_KEY },
      timeout: 30000 
    }
  ));
  
  return (res.data?.data?.translations || []).map(t => t.translatedText || '');
}

async function deepLTranslate(texts, to) {
  if (!DEEPL_API_KEY) throw new Error('DEEPL_API_KEY required');
  
  const form = new URLSearchParams();
  texts.forEach(text => form.append('text', text));
  form.append('target_lang', to.replace('-', '').slice(0, 2).toUpperCase());
  
  const res = await limiter.schedule(() => axios.post(
    'https://api-free.deepl.com/v2/translate',
    form.toString(),
    {
      headers: { 
        'Authorization': `DeepL-Auth-Key ${DEEPL_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 30000
    }
  ));
  
  return (res.data?.translations || []).map(t => t.text || '');
}

// Progressive translation with status updates
async function progressiveTranslate(cacheKey, subtitleContent, toLang, engine) {
  console.log(`Starting progressive translation: ${cacheKey}`);
  
  try {
    const blocks = parseSRT(subtitleContent);
    const sourceHash = hashStr(subtitleContent);
    
    // Initialize translation record
    await db.run(`INSERT OR REPLACE INTO translation_cache
      (key, to_lang, engine, source_hash, srt_content, status, progress, created_at) 
      VALUES (?,?,?,?,?,?,?,?)`,
      cacheKey, toLang, engine, sourceHash, '', 'pending', 0, Date.now()
    );
    
    const texts = blocks.map(b => b.text);
    const translatedTexts = await translateTexts(texts, toLang, engine);
    
    // Build final SRT
    const translatedBlocks = blocks.map((block, i) => ({
      ...block,
      text: translatedTexts[i] || block.text
    }));
    
    const finalSrt = buildSRT(translatedBlocks);
    
    // Save completed translation
    await db.run(`UPDATE translation_cache 
      SET srt_content=?, status='done', progress=100 
      WHERE key=?`, finalSrt, cacheKey);
    
    console.log(`Translation completed: ${cacheKey}`);
    return finalSrt;
    
  } catch (error) {
    console.error(`Translation failed: ${cacheKey}`, error);
    await db.run(`UPDATE translation_cache 
      SET status='error', progress=0 
      WHERE key=?`, cacheKey);
    throw error;
  }
}

// Initialize
await initDB();

// Express app
const app = express();
app.use(express.json());
app.use(express.static('public'));

// Manifest with configurable languages
const buildManifest = () => ({
  "id": "org.custom.subtranslate.v2",
  "version": "2.0.0",
  "name": "AI Subtitle Translator",
  "description": "Smart subtitle translation with OpenSubtitles priority and caching",
  "resources": ["subtitles"],
  "types": ["movie", "series"],
  "idPrefixes": ["tt"],
  "behaviorHints": { 
    "configurable": true, 
    "configurationRequired": false 
  },
  "config": DEFAULT_TO_LANGS.map(lang => ({
    "key": `translate_${lang}`,
    "type": "boolean",
    "title": `Translate to ${lang}`,
    "default": lang === DEFAULT_TO_LANGS[0]
  })),
  "catalogs": []
});

const builder = new addonBuilder(buildManifest());

// Main subtitles handler
builder.defineSubtitlesHandler(async ({ id, extra = {} }) => {
  console.log(`Subtitle request: ${id}, config:`, extra);
  
  try {
    const [imdb_id, season, episode] = id.split(':');
    if (!imdb_id) throw new Error('Invalid ID format');
    
    // Parse enabled languages from config
    const enabledLangs = DEFAULT_TO_LANGS.filter(lang => 
      extra[`translate_${lang}`] !== false
    );
    
    if (!enabledLangs.length) {
      return { subtitles: [] };
    }
    
    const subtitles = [];
    
    // For each enabled language
    for (const toLang of enabledLangs) {
      const cacheKey = `${imdb_id}|${season||''}|${episode||''}|${toLang}|${ENGINE}`;
      
      // Check translation cache
      const cached = await db.get(`SELECT * FROM translation_cache WHERE key=?`, cacheKey);
      
      if (cached?.status === 'done' && cached.srt_content) {
        // Return cached translation
        const dataUri = 'data:text/plain;charset=utf-8;base64,' + 
          Buffer.from(cached.srt_content).toString('base64');
        subtitles.push({
          id: `translated-${toLang}`,
          lang: toLang,
          url: dataUri
        });
        continue;
      }
      
      // Try to find native subtitle first
      try {
        const targetLang = toLang.split('-')[0];
        const nativeContent = await searchAndCacheOpenSubtitles(imdb_id, season, episode, targetLang);
        
        if (nativeContent) {
          const dataUri = 'data:text/plain;charset=utf-8;base64,' + 
            Buffer.from(nativeContent).toString('base64');
          subtitles.push({
            id: `native-${toLang}`,
            lang: toLang,
            url: dataUri
          });
          continue;
        }
      } catch (error) {
        console.warn(`Native subtitle search failed for ${toLang}:`, error.message);
      }
      
      // Start translation if not cached
      if (!cached || cached.status === 'error') {
        try {
          const englishContent = await searchAndCacheOpenSubtitles(imdb_id, season, episode, 'en');
          if (englishContent) {
            // Start background translation
            progressiveTranslate(cacheKey, englishContent, toLang, ENGINE)
              .catch(err => console.error('Background translation failed:', err));
            
            // Return processing status
            subtitles.push({
              id: `processing-${toLang}`,
              lang: toLang,
              url: 'data:text/plain;charset=utf-8;base64,' + Buffer.from(
                `1\n00:00:00,000 --> 00:00:30,000\n🔄 Translating to ${toLang}... Please refresh in 30-60 seconds.\n`
              ).toString('base64')
            });
          }
        } catch (error) {
          console.error(`Translation initiation failed for ${toLang}:`, error.message);
        }
      }
    }
    
    return { subtitles };
    
  } catch (error) {
    console.error('Subtitle handler error:', error);
    return { subtitles: [] };
  }
});

// Routes
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`
    <h2>🎬 AI Subtitle Translator v2.0</h2>
    <p><strong>Manifest URL:</strong> <code>${BASE_URL}/manifest.json</code></p>
    <p><strong>Features:</strong></p>
    <ul>
      <li>✅ OpenSubtitles native language priority</li>
      <li>✅ Smart caching system</li>
      <li>✅ Multi-language support: ${DEFAULT_TO_LANGS.join(', ')}</li>
      <li>✅ Progressive translation</li>
    </ul>
    <p><strong>Status:</strong> <a href="/status">View cache status</a></p>
  `);
});

app.get('/manifest.json', (req, res) => {
  res.json(builder.getInterface().manifest);
});

app.get('/status', async (req, res) => {
  try {
    const stats = await db.all(`
      SELECT status, COUNT(*) as count 
      FROM translation_cache 
      GROUP BY status
    `);
    
    const recent = await db.all(`
      SELECT key, to_lang, status, progress, created_at
      FROM translation_cache 
      ORDER BY created_at DESC 
      LIMIT 20
    `);
    
    res.json({ stats, recent });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '2.0.0',
    timestamp: Date.now()
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Subtitle Translator v2.0 running on ${BASE_URL}`);
  console.log(`📋 Manifest: ${BASE_URL}/manifest.json`);
  console.log(`🔧 Supported languages: ${DEFAULT_TO_LANGS.join(', ')}`);
});
