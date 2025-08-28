// index.js - 终极修复版本
// 彻底移除 OpenSubtitles 依赖，使用Stremio自带的字幕源，确保服务稳定。

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
const BASE_URL = process.env.BASE_URL || process.env.RAILWAY_STATIC_URL || `http://localhost:${PORT}`;
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
    CREATE TABLE IF NOT EXISTS translation_cache (
      key TEXT PRIMARY KEY,
      to_lang TEXT,
      engine TEXT,
      source_hash TEXT,
      srt_content TEXT,
      status TEXT,
      created_at INTEGER
    );
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

async function progressiveTranslate(cacheKey, subtitleContent, toLang, engine) {
  try {
    const blocks = parseSRT(subtitleContent);
    const sourceHash = hashStr(subtitleContent);
    
    await db.run(`INSERT OR REPLACE INTO translation_cache
      (key, to_lang, engine, source_hash, srt_content, status, created_at) 
      VALUES (?,?,?,?,?,?,?)`,
      cacheKey, toLang, engine, sourceHash, '', 'pending', Date.now()
    );
    
    const texts = blocks.map(b => b.text);
    const translatedTexts = await translateTexts(texts, toLang, engine);
    
    const translatedBlocks = blocks.map((block, i) => ({
      ...block,
      text: translatedTexts[i] || block.text
    }));
    
    const finalSrt = buildSRT(translatedBlocks);
    
    await db.run(`UPDATE translation_cache 
      SET srt_content=?, status='done' 
      WHERE key=?`, finalSrt, cacheKey);
    
    return finalSrt;
  } catch (error) {
    console.error(`Translation failed: ${cacheKey}`, error);
    await db.run(`UPDATE translation_cache 
      SET status='error'
      WHERE key=?`, cacheKey);
    throw error;
  }
}

console.log('🔄 Initializing database...');
await initDB().catch(err => {
  console.error('❌ Database initialization failed:', err);
  process.exit(1);
});
console.log('✅ Database initialized successfully');

const app = express();
app.use(express.json());
app.use(express.static('public'));

console.log('🔄 Setting up routes...');

app.get('/subtitles/:type/:id/:filename', async (req, res) => {
  const { type, id } = req.params;
  const sdkId = `${type}/${id}`;
  const response = await handleSubtitles({ id: sdkId });
  res.json(response);
});

const handleSubtitles = async ({ id, extra = {}, subtitles: stremioSubtitles = [] }) => {
  console.log(`Subtitle request: ${id}, config:`, extra);
  
  try {
    const [type, imdb_id, season, episode] = id.split(/[:\/]/).filter(Boolean);
    if (!imdb_id) throw new Error('Invalid ID format');
    
    const enabledLangs = DEFAULT_TO_LANGS.filter(lang => 
      extra[`translate_${lang}`] !== false
    );
    
    if (!enabledLangs.length) {
      return { subtitles: [] };
    }
    
    const subtitles = [];
    
    // 从Stremio自带的字幕列表中寻找英文字幕
    const englishSub = stremioSubtitles.find(sub => sub.lang.toLowerCase() === 'en');
    
    if (englishSub && englishSub.url) {
      const englishContentRes = await axios.get(englishSub.url, { responseType: 'text', timeout: 30000 });
      const englishContent = englishContentRes.data;
      
      for (const toLang of enabledLangs) {
        const cacheKey = `${imdb_id}|${season||''}|${episode||''}|${toLang}|${ENGINE}`;
        const cached = await db.get(`SELECT * FROM translation_cache WHERE key=?`, cacheKey);
        
        if (cached?.status === 'done' && cached.srt_content) {
          const dataUri = 'data:text/plain;charset=utf-8;base64,' + 
            Buffer.from(cached.srt_content).toString('base64');
          subtitles.push({
            id: `translated-${toLang}`,
            lang: toLang,
            url: dataUri
          });
        } else {
          progressiveTranslate(cacheKey, englishContent, toLang, ENGINE)
            .catch(err => console.error('Background translation failed:', err));
          
          subtitles.push({
            id: `processing-${toLang}`,
            lang: toLang,
            url: 'data:text/plain;charset=utf-8;base64,' + Buffer.from(
              `1\n00:00:00,000 --> 00:00:30,000\n🔄 Translating to ${toLang}... Please refresh in 30-60 seconds.\n`
            ).toString('base64')
          });
        }
      }
    } else {
      console.log('No English subtitles found in Stremio\'s own list.');
    }
    
    return { subtitles };
    
  } catch (error) {
    console.error('Subtitle handler error:', error);
    return { subtitles: [] };
  }
};

const builder = new addonBuilder({
  "id": "org.custom.subtranslate.v3",
  "version": "3.0.0",
  "name": "AI Subtitle Translator (Direct)",
  "description": "Smart subtitle translation that directly uses Stremio's built-in subtitle sources.",
  "resources": ["subtitles"],
  "types": ["movie", "series"],
  "idPrefixes": ["tt"],
  "behaviorHints": { "configurable": true, "configurationRequired": false },
  "config": DEFAULT_TO_LANGS.map(lang => ({
    "key": `translate_${lang}`,
    "type": "boolean",
    "title": `Translate to ${lang}`,
    "default": lang === DEFAULT_TO_LANGS[0]
  })),
  "catalogs": []
});

builder.defineSubtitlesHandler(handleSubtitles);

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`...`);
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
      SELECT key, to_lang, status, created_at
      FROM translation_cache 
      ORDER BY created_at DESC 
      LIMIT 20
    `);
    res.json({ stats, recent });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', async (req, res) => {
  try {
    await db.get('SELECT 1');
    const health = { 
      status: 'ok', 
      version: '3.0.0',
      timestamp: Date.now(),
      port: PORT,
      base_url: BASE_URL,
      database: 'connected',
      google_configured: !!GOOGLE_API_KEY,
      deepl_configured: !!DEEPL_API_KEY,
      environment: process.env.NODE_ENV || 'development'
    };
    res.json(health);
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message });
  }
});

console.log('✅ Routes configured');

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Subtitle Translator v3.0 running on port ${PORT}`);
  console.log(`📋 Manifest: ${BASE_URL}/manifest.json`);
});

server.on('error', (error) => {
  console.error('❌ Server error:', error);
  process.exit(1);
});

process.on('SIGTERM', () => {
  server.close(() => {
    if (db) {
      db.close().then(() => { process.exit(0); });
    } else {
      process.exit(0);
    }
  });
});
