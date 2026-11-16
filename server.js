// Minimal local server for Product Listing Writer.
// Serves index.html and proxies listing generation to the ILMU API,
// keeping the API key off the browser. No dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.ILMU_CONFIG_PATH || path.join(process.env.USERPROFILE || process.env.HOME || '', '.ilmucode', 'v2', 'config.json');
let provider = null;
try { provider = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).provider['builtin:ilmu']; } catch {}
// Priority: env var (Railway) > config.local.js (local dev) > ILMUcode config (local fallback)
let local = {};
try { local = require('./config.local.js'); } catch {}
const apiKey = process.env.ILMU_API_KEY || local.apiKey || (provider && provider.options.apiKey);
const baseURL = process.env.ILMU_BASE_URL || local.baseURL || (provider && provider.options.baseURL) || 'https://api.ilmu.ai/anthropic';
const MODEL = process.env.ILMU_MODEL || local.model || 'ilmu-glm-5.3';

const PORT = process.env.PORT || 3456;
const DIR = __dirname;

const LANG_NAMES = { en: 'English', bm: 'Bahasa Melayu', zh: 'Chinese (Simplified)' };
const MARKET_NAMES = { shopee: 'Shopee', lazada: 'Lazada', tiktok: 'TikTok Shop' };
const CAT_NAMES = {
  fashion: 'Fashion', beauty: 'Beauty', food: 'Food & Snacks',
  electronics: 'Electronics', home: 'Home & Living', accessories: 'Accessories'
};

function buildPrompt(name, lang, market, cat) {
  return `You are an expert e-commerce copywriter for Southeast Asian marketplaces. A merchant uploaded a product photo (attached). Analyze the image to understand what the product is.

Product keywords given by merchant: "${name}"
Category: ${CAT_NAMES[cat] || 'General'}
Language for ALL output: ${LANG_NAMES[lang] || 'English'}
Target marketplace: ${MARKET_NAMES[market] || 'Shopee'} (tailor tone, title style and hashtags to this platform)

Return ONLY valid JSON (no markdown fences) with exactly these keys:
- "title": marketplace product title, max 60-80 chars, platform-appropriate style
- "desc": product description, 80-150 words, persuasive, with a few emojis, plain text with \\n line breaks
- "points": array of exactly 5 short key selling points (each under 12 words)
- "tags": array of 8-12 relevant hashtags, each starting with #

If the photo does not clearly show a product, still generate the listing based on the keywords.`;
}

function parseListing(text) {
  let t = text.replace(/^```json?\s*|```\s*$/g, '').trim();
  let parsed = JSON.parse(t);
  if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  return {
    title: String(parsed.title || '').trim(),
    desc: String(parsed.desc || '').trim(),
    points: (parsed.points || []).map(String),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).join(' ') : String(parsed.tags || '')
  };
}

const server = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

  if (req.method === 'POST' && req.url === '/api/generate') {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 12e6) req.destroy(); });
    req.on('end', async () => {
      try {
        const { image, mediaType, name, lang, market, cat } = JSON.parse(raw);
        const content = [];
        if (image) {
          content.push({ type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } });
        }
        content.push({ type: 'text', text: buildPrompt(name, lang, market, cat) });

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 90000);
        let apiRes;
        try {
          apiRes = await fetch(baseURL + '/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: MODEL, max_tokens: 2000, messages: [{ role: 'user', content }] }),
            signal: controller.signal
          });
        } finally {
          clearTimeout(timeout);
        }
        if (!apiRes.ok) throw new Error('ILMU API ' + apiRes.status + ': ' + (await apiRes.text()).slice(0, 200));
        const data = await apiRes.json();
        const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({ ok: true, listing: parseListing(text) }));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json', ...cors });
        res.end(JSON.stringify({ ok: false, error: String(err.message || err).slice(0, 300) }));
      }
    });
    return;
  }

  // static files
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.join(DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, () => console.log(`ListingAI running at http://localhost:${PORT}`));
