const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-this-password';
if (ADMIN_PASSWORD === 'change-this-password') console.warn('WARNING: ADMIN_PASSWORD is not set, admin login is disabled.');
const DATA_DIR = path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
// Set UPLOAD_DIR to a Render persistent-disk path so uploaded photos survive redeploys.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.set('trust proxy', 1);
if (!fs.existsSync(PRODUCTS_FILE)) fs.writeFileSync(PRODUCTS_FILE, '[]');
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/admin') || req.path.startsWith('/api/admin')) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));

// Allow the separate Cloudflare storefront to use this Render backend.
const ALLOWED_ORIGINS = new Set([
  'https://caayo-finds.covenantatafo4.workers.dev',
  'https://caayo-finds.onrender.com'
]);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Only serve the public pages and uploaded photos (never server.js or the data folder).
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
function escapeHtmlText(value) {
  return cleanText(value).replace(/[<>]/g, '');
}
function makeId() { return crypto.randomBytes(8).toString('hex'); }
function validPddUrl(value) {
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    return host.includes('yangkeduo.com') || host.includes('pinduoduo.com');
  } catch { return false; }
}
function absoluteUrl(value, baseUrl) {
  try {
    const s = String(value || '').trim()
      .replace(/\\u002F/g, '/')
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&');
    if (!s) return '';
    return new URL(s, baseUrl).href;
  } catch { return ''; }
}
function isImageUrl(value) {
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol)) return false;
    return /\.(?:jpg|jpeg|png|webp|gif|avif)(?:$|[?#])/i.test(u.pathname + u.search) ||
      /\/(?:image|img|goods|upload|pic)\//i.test(u.pathname);
  } catch { return false; }
}
function uniqueImages(list) {
  const out=[]; const seen=new Set();
  for (const item of list) {
    const u=String(item||'').trim(); if(!u || !isImageUrl(u)) continue;
    const key=u.split('#')[0]; if(!seen.has(key)){seen.add(key);out.push(u);}
  }
  return out.slice(0,30);
}
function stripHtml(value) {
  return cleanText(String(value||'')
    .replace(/<script[\s\S]*?<\/script>/gi,' ')
    .replace(/<style[\s\S]*?<\/style>/gi,' ')
    .replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"')
    .replace(/&#39;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>'));
}
function extractMeta(html, key, attr='property') {
  const safe=key.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&');
  const re=new RegExp(`<meta[^>]+(?:${attr}=["']${safe}["'][^>]*content=["']([^"']*)["']|content=["']([^"']*)["'][^>]*${attr}=["']${safe}["'])[^>]*>`,'i');
  const m=html.match(re); return cleanText(m?.[1]||m?.[2]||'');
}
function extractAttrImages(html, baseUrl) {
  const images=[];
  const re=/<(?:img|source)\b[^>]*(?:src|data-src|data-original|data-lazy-src|data-url)=["']([^"']+)["'][^>]*>/gi;
  for(const m of html.matchAll(re)){const u=absoluteUrl(m[1],baseUrl);if(u)images.push(u);}
  for(const m of html.matchAll(/https?:\/\/[^"'\s<>]+/gi)){const u=absoluteUrl(m[0].replace(/\\\//g,'/'),baseUrl);if(u&&isImageUrl(u))images.push(u);}
  return uniqueImages(images);
}
function collectJsonLd(html, baseUrl) {
  let title='',description='',sourcePrice=0; const imageUrls=[];
  for(const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
    try{
      const parsed=JSON.parse(match[1].trim());
      const items=Array.isArray(parsed)?parsed:[parsed];
      const walk=item=>{
        if(!item||typeof item!=='object')return;
        if(!title&&item.name)title=cleanText(item.name);
        if(!description&&item.description)description=stripHtml(item.description);
        for(const img of (Array.isArray(item.image)?item.image:[item.image])){const u=absoluteUrl(img,baseUrl);if(u)imageUrls.push(u);}
        const offers=Array.isArray(item.offers)?item.offers[0]:item.offers;
        if(!sourcePrice&&offers?.price)sourcePrice=Number(String(offers.price).replace(/[^0-9.]/g,''))||0;
        Object.values(item).forEach(v=>{if(v&&typeof v==='object')walk(v);});
      };
      items.forEach(walk);
    }catch{}
  }
  return {title,description,sourcePrice,imageUrls:uniqueImages(imageUrls)};
}
function extractEmbeddedPddData(html, baseUrl) {
  let title='',description='',sourcePrice=0; const images=[];
  const pick=keys=>{
    for(const key of keys){
      const re=new RegExp(`["']${key}["']\\s*:\\s*["']([^"']{2,1000})["']`,'i');
      const m=html.match(re);
      if(m)return stripHtml(m[1].replace(/\\"/g,'"'));
    }
    return '';
  };
  title=pick(['goods_name','goodsName','goods_title','goodsTitle','name']);
  description=pick(['desc','description','goods_desc','goodsDesc']);
  const pm=html.match(/["'](?:price|goods_price|min_group_price)["']\s*:\s*["']?([0-9]+(?:\.[0-9]+)?)/i);
  if(pm)sourcePrice=Number(pm[1])||0;
  const arrayRe=/["'](?:item_imgs|itemImages|gallery|galleryImages|goods_gallery|detail_imgs)["']\s*:\s*\[([\s\S]{0,50000}?)\]/gi;
  for(const m of html.matchAll(arrayRe)){
    for(const u of m[1].matchAll(/["'](https?:\/\/[^"']+)["']/g)){
      const a=absoluteUrl(u[1],baseUrl); if(a)images.push(a);
    }
  }
  return {title,description,sourcePrice,imageUrls:uniqueImages(images)};
}
// ---------- Page fetching ----------
const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
function cleanMultiline(value) {
  return String(value || '').replace(/[<>]/g, '').split('\n').map(l => l.replace(/[ \t\r]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
}
// Any public http(s) link is allowed, but never the server's own network.
async function checkPublicUrl(value) {
  let u;
  try { u = new URL(value); } catch { return { ok: false, error: 'Please paste a full product link starting with https://' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: 'Please paste a full product link starting with https://' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) return { ok: false, error: 'That address is not allowed.' };
  try {
    const addrs = await dns.lookup(host, { all: true });
    const bad = a => /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a) || /^(::1|fc|fd|fe80)/i.test(a);
    if (!addrs.length || addrs.some(x => bad(x.address))) return { ok: false, error: 'That address is not allowed.' };
  } catch { return { ok: false, error: 'Could not find that website. Check the link.' }; }
  return { ok: true };
}
function mobileUrl(inputUrl) {
  try {
    const u = new URL(inputUrl);
    const id = u.searchParams.get('goods_id');
    if (id && /yangkeduo|pinduoduo/i.test(u.hostname)) return 'https://mobile.yangkeduo.com/goods.html?goods_id=' + encodeURIComponent(id);
  } catch {}
  return inputUrl;
}
const isGenericTitle = t => !t || String(t).trim().length < 2 || /^(拼多多商城|拼多多|pinduoduo|yangkeduo|拼多多\s*[-|]\s*.*商城)$/i.test(String(t).trim());
async function fetchOnce(url, ua) {
  const r = await fetch(url, { redirect: 'follow', headers: {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
    'Referer': 'https://mobile.yangkeduo.com/'
  }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`The website returned HTTP ${r.status}`);
  return { html: await r.text(), finalUrl: r.url || url };
}
function pageScore(html) {
  if (/window\.rawData|goods_name|goodsName/.test(html)) return 3;
  if (/"@type"\s*:\s*"Product"/i.test(html)) return 2;
  const t = extractMeta(html, 'og:title') || cleanText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  if (!isGenericTitle(t)) return 2;
  return html.length > 500 ? 1 : 0;
}
// The original fetch from the first version of this server (kept exactly as it was).
async function fetchProductPageOriginal(inputUrl) {
  const response=await fetch(inputUrl,{redirect:'follow',headers:{
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language':'en-US,en;q=0.9,zh-CN;q=0.8','Cache-Control':'no-cache'
  },signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(`Pinduoduo returned HTTP ${response.status}`);
  return {html:await response.text(),finalUrl:response.url||inputUrl};
}
// Try the original first. Only if it gets no real product page, try extra attempts (mobile browser, redirected goods_id).
async function fetchProductPage(inputUrl) {
  let best = null, lastErr = null;
  try {
    const first = await fetchProductPageOriginal(inputUrl);
    first.score = pageScore(first.html);
    if (first.score >= 2) return first;
    best = first;
  } catch (e) { lastErr = e; }
  const attempts = [[mobileUrl(inputUrl), UA_MOBILE], [inputUrl, UA_MOBILE]];
  if (best) { const m = mobileUrl(best.finalUrl); if (!attempts.some(a => a[0] === m)) attempts.push([m, UA_MOBILE]); }
  for (let i = 0; i < attempts.length; i++) {
    const [u, ua] = attempts[i];
    try {
      const res = await fetchOnce(u, ua);
      res.score = pageScore(res.html);
      if (!best || res.score > best.score) best = res;
      if (res.score >= 2) return res;
    } catch (e) { lastErr = e; }
  }
  if (best) return best;
  throw lastErr || new Error('Could not load the page');
}
// Pinduoduo mobile pages embed the product as window.rawData = {...}
function extractRawData(html) {
  const i = html.search(/window\.rawData\s*=\s*/);
  if (i < 0) return null;
  const start = html.indexOf('{', i);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let p = start; p < html.length; p++) {
    const ch = html[p];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { try { return JSON.parse(html.slice(start, p + 1)); } catch { return null; } } }
  }
  return null;
}
function readRawData(raw) {
  const out = { title: '', description: '', sourcePrice: 0, details: [], shop: '', sales: '' };
  if (!raw) return out;
  const options = new Map();
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 9) return;
    if (Array.isArray(o)) { o.forEach(v => walk(v, depth + 1)); return; }
    const str = v => (typeof v === 'string' ? cleanText(v) : '');
    if (!out.title) out.title = str(o.goodsName) || str(o.goods_name);
    if (!out.description && typeof o.goodsDesc === 'string') out.description = stripHtml(o.goodsDesc);
    if (!out.shop) out.shop = str(o.mallName) || str(o.mall_name);
    if (!out.sales) out.sales = str(o.salesTip) || str(o.sales_tip);
    for (const k of ['minGroupPrice', 'min_group_price', 'minOnSaleGroupPrice']) {
      if (!out.sourcePrice && Number(o[k]) > 0) out.sourcePrice = Number(o[k]) / 100;   // prices are in fen
    }
    for (const k of ['goodsProperty', 'goods_property']) {
      if (!Array.isArray(o[k])) continue;
      for (const g of o[k]) {
        const key = str(g && (g.key || g.name)); const val = Array.isArray(g && g.values) ? g.values.map(cleanText).join(', ') : str(g && (g.value || g.values));
        if (key && val) out.details.push({ k: key, v: val });
      }
    }
    if (Array.isArray(o.skus)) {
      for (const sku of o.skus) for (const sp of (sku && (sku.specs || sku.spec) || [])) {
        const k = str(sp && (sp.spec_key || sp.specKey)), v = str(sp && (sp.spec_value || sp.specValue));
        if (k && v) { if (!options.has(k)) options.set(k, new Set()); options.get(k).add(v); }
      }
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  walk(raw);
  for (const [k, set] of options) out.details.push({ k: 'Options - ' + k, v: [...set].slice(0, 30).join(', ') });
  return out;
}
function jsonLdDetails(html) {
  const d = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const add = (k, v) => { v = (v && typeof v === 'object') ? cleanText(v.name || '') : cleanText(v); if (v) d.push({ k, v }); };
      const walk = o => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (o['@type'] === 'Product' || o.sku) {
          add('Brand', o.brand); add('SKU', o.sku); add('Category', o.category); add('Color', o.color); add('Material', o.material); add('Model', o.model);
          for (const p of (Array.isArray(o.additionalProperty) ? o.additionalProperty : [])) if (p && p.name) add(cleanText(p.name), p.value);
        }
        Object.values(o).forEach(walk);
      };
      walk(JSON.parse(m[1].trim()));
    } catch {}
  }
  return d;
}
// Everything the link can tell us (images are skipped on purpose, you upload your own).
function extractProduct(html, finalUrl) {
  const raw = readRawData(extractRawData(html));
  const ld = collectJsonLd(html, finalUrl);
  const emb = extractEmbeddedPddData(html, finalUrl);
  const ogTitle = extractMeta(html, 'og:title');
  const htmlTitle = cleanText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const title = [raw.title, ld.title, ogTitle, htmlTitle, emb.title].find(x => x && !isGenericTitle(x)) || '';
  let description = title ? ([raw.description, ld.description, extractMeta(html, 'og:description'), extractMeta(html, 'description', 'name'), emb.description]
    .find(x => x && String(x).trim().length > 3 && !isGenericTitle(x)) || '') : '';
  const details = [...raw.details, ...jsonLdDetails(html)];
  if (title) {
    if (raw.shop) details.push({ k: 'Seller', v: raw.shop });
    if (raw.sales) details.push({ k: 'Sales', v: raw.sales });
    const kw = extractMeta(html, 'keywords', 'name');
    if (kw && !isGenericTitle(kw)) details.push({ k: 'Keywords', v: kw });
  }
  const seen = new Set();
  const uniq = details.filter(d => { const key = d.k + '|' + d.v; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 40);
  const sourcePrice = Number(raw.sourcePrice || ld.sourcePrice || emb.sourcePrice || String(extractMeta(html, 'product:price:amount') || extractMeta(html, 'og:price:amount')).replace(/[^0-9.]/g, '') || 0);
  return { title, description, details: uniq, sourcePrice };
}

// ---------- Any language -> English ----------
// Order tried: Google Cloud Translation (if GOOGLE_TRANSLATE_API_KEY is set), Google's free web endpoint, MyMemory.
const needsTranslation = s => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Thai}\p{Script=Devanagari}\p{Script=Greek}\p{Script=Bengali}\p{Script=Tamil}]/u.test(String(s || ''));
const hasChinese = s => /[\u3400-\u9fff\uf900-\ufaff]/.test(String(s || ''));
const trCache = new Map();
const trFail = new Map();
const MAX_BYTES = 450;   // MyMemory allows 500 bytes per request, and Chinese characters use 3 bytes each
function chunkText(text) {
  const pieces = [];
  let cur = '';
  const push = () => { if (cur.trim()) pieces.push(cur); cur = ''; };
  for (const token of String(text).split(/(?<=[。！？!?；;\n])/)) {
    if (Buffer.byteLength(cur + token) > MAX_BYTES) push();
    if (Buffer.byteLength(token) > MAX_BYTES) {
      let part = '';
      for (const ch of token) { if (Buffer.byteLength(part + ch) > MAX_BYTES) { pieces.push(part); part = ''; } part += ch; }
      cur = part;
    } else cur += token;
  }
  push();
  return pieces;
}
async function translateChunk(q) {
  const key = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (key) {
    try {
      const r = await fetch('https://translation.googleapis.com/language/translate/v2?key=' + encodeURIComponent(key), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q, target: 'en', format: 'text' }), signal: AbortSignal.timeout(10000)
      });
      const d = await r.json();
      const t = d && d.data && d.data.translations && d.data.translations[0] && d.data.translations[0].translatedText;
      if (r.ok && t) return t;
    } catch {}
  }
  try {
    const r = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=' + encodeURIComponent(q), {
      headers: { 'User-Agent': UA_DESKTOP }, signal: AbortSignal.timeout(10000)
    });
    const d = await r.json();
    const t = Array.isArray(d && d[0]) ? d[0].map(x => (x && x[0]) || '').join('') : '';
    if (r.ok && t) return t;
  } catch {}
  const de = process.env.MYMEMORY_EMAIL ? '&de=' + encodeURIComponent(process.env.MYMEMORY_EMAIL) : '';
  const pair = hasChinese(q) ? 'zh-CN|en' : 'Autodetect|en';
  const r = await fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q) + '&langpair=' + pair + de, { signal: AbortSignal.timeout(10000) });
  const d = await r.json();
  const t = d && d.responseData && d.responseData.translatedText;
  if (!r.ok || !t || /MYMEMORY WARNING|INVALID|QUERY LENGTH/i.test(t)) throw new Error('All translation services failed or are rate-limited');
  return t;
}
// force = translate even when the text looks Latin (used by the admin Translate button)
async function toEnglish(text, force = false) {
  const s = String(text || '').trim();
  if (!s || (!force && !needsTranslation(s))) return s;
  if (trCache.has(s)) return trCache.get(s);
  const failed = trFail.get(s);
  if (!force && failed && Date.now() - failed < 5 * 60 * 1000) return s;   // don't hammer a failing service
  try {
    let out = '';
    for (const piece of chunkText(s)) {
      const sep = /\n\s*$/.test(piece) ? '\n' : ' ';
      const t = await translateChunk(piece.trim());
      out += t.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim() + sep;
    }
    const t = cleanMultiline(out);
    if (t) { trCache.set(s, t); if (trCache.size > 2000) trCache.delete(trCache.keys().next().value); return t; }
  } catch (e) {
    console.warn('Translation failed:', e.message);
    trFail.set(s, Date.now()); if (trFail.size > 500) trFail.delete(trFail.keys().next().value);
  }
  return s;   // never lose the original text if translation is unavailable
}

// ---------- Admin sessions (12-hour tokens, login attempts limited) ----------
const DEFAULT_PASSWORD = 'change-this-password';
const adminTokens = new Map();   // token -> expiry time
const loginFails = new Map();    // ip -> { n, until }
const TOKEN_TTL = 12 * 60 * 60 * 1000;
function adminAuthed(token) {
  const exp = adminTokens.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { adminTokens.delete(token); return false; }
  return true;
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
  if (!token || !adminAuthed(token)) return res.status(401).json({ error: 'Admin login required' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip;
  let f = loginFails.get(ip);
  if (f && f.until && f.until <= Date.now()) { loginFails.delete(ip); f = null; }
  if (f && f.until > Date.now()) return res.status(429).json({ error: 'Too many wrong attempts. Try again in 15 minutes.' });
  if (ADMIN_PASSWORD === DEFAULT_PASSWORD) {
    return res.status(503).json({ error: 'Admin is locked until you set the ADMIN_PASSWORD environment variable on your server.' });
  }
  if (!req.body?.password || !safeEqual(req.body.password, ADMIN_PASSWORD)) {
    const n = (f?.n || 0) + 1;
    loginFails.set(ip, { n, until: n >= 5 ? Date.now() + 15 * 60 * 1000 : 0 });
    return res.status(401).json({ error: 'Incorrect password' });
  }
  loginFails.delete(ip);
  const token = crypto.randomBytes(24).toString('hex');
  adminTokens.set(token, Date.now() + TOKEN_TTL);
  res.json({ token });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  adminTokens.delete(req.headers.authorization?.replace(/^Bearer\s+/i, ''));
  res.json({ ok: true });
});

app.post('/api/admin/translate', requireAdmin, async (req, res) => {
  const out = {};
  for (const k of ['name', 'description']) {
    if (typeof req.body?.[k] === 'string') out[k] = await toEnglish(cleanMultiline(req.body[k]), true);
  }
  res.json({ ok: true, ...out });
});

// Public storefront product endpoint used by index.html.
app.get('/api/products', async (req, res) => {
  let products = readJson(PRODUCTS_FILE).filter(p => p.active !== false);
  products = await Promise.all(products.map(async p => (needsTranslation(p.name) || needsTranslation(p.description))
    ? { ...p, name: await toEnglish(p.name), description: await toEnglish(p.description) } : p));
  const q = cleanText(req.query.q).toLowerCase();
  if (q) products = products.filter(p => `${p.name} ${p.category}`.toLowerCase().includes(q));
  res.json({ products });
});

// Photo upload from the admin page (images are resized in the browser first).
app.post('/api/admin/upload', requireAdmin, (req, res) => {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.data || ''));
  if (!m) return res.status(400).json({ error: 'Send a JPEG, PNG or WebP image.' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 3 * 1024 * 1024) return res.status(413).json({ error: 'Image is too large (max 3 MB).' });
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const file = makeId() + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
  const base = (process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');
  res.json({ ok: true, url: base + '/uploads/' + file });
});

app.get('/api/admin/products', requireAdmin, (req, res) => {
  res.json({ products: readJson(PRODUCTS_FILE) });
});

// Import product data from a public Pinduoduo/Yangkeduo URL. No Pinduoduo API key is used.
app.post('/api/admin/import-url', requireAdmin, async (req, res) => {
  const url=cleanText(req.body?.url);
  const check=await checkPublicUrl(url);
  if(!check.ok)return res.status(400).json({error:check.error});
  try{
    const {html,finalUrl}=await fetchProductPage(url);
    // ---- original extraction (unchanged) ----
    const ogTitle=extractMeta(html,'og:title');
    const metaDescription=extractMeta(html,'description','name');
    const ogDescription=extractMeta(html,'og:description');
    const ogImage=absoluteUrl(extractMeta(html,'og:image'),finalUrl);
    const jsonLd=collectJsonLd(html,finalUrl);
    const embedded=extractEmbeddedPddData(html,finalUrl);
    let images=uniqueImages([ogImage,...jsonLd.imageUrls,...embedded.imageUrls,...extractAttrImages(html,finalUrl)]);
    // ---- additions: extra details, translation, and not saving Pinduoduo's own logo as a product ----
    let rawD={title:'',description:''}, extra={details:[],sourcePrice:0};
    try{rawD=readRawData(extractRawData(html));extra=extractProduct(html,finalUrl);}catch{}
    const htmlTitle=cleanText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||'');
    const rawTitle=[rawD.title,ogTitle,jsonLd.title,embedded.title,htmlTitle].find(t=>t&&!isGenericTitle(t))||'';
    const blocked=!rawTitle;
    images=images.filter(u=>!/share_logo|\/base\/|favicon/i.test(u));
    if(blocked)images=[];
    const baseDescription=blocked?'':(rawD.description||embedded.description||jsonLd.description||ogDescription||metaDescription||'');
    const detailText=blocked?'':extra.details.map(d=>`${d.k}: ${d.v}`).join('\n');
    const fullText=[cleanMultiline(baseDescription),detailText?'Details:\n'+detailText:''].filter(Boolean).join('\n\n');
    const title=blocked?'':((await toEnglish(escapeHtmlText(rawTitle)))||escapeHtmlText(rawTitle));
    const description=fullText?await toEnglish(fullText):'';
    const sourcePrice=blocked?0:Number(extra.sourcePrice||embedded.sourcePrice||jsonLd.sourcePrice||req.body?.sourcePrice||0);
    const products=readJson(PRODUCTS_FILE);
    const existing=products.find(p=>p.sourceUrl===url||p.sourceUrl===finalUrl||p.originalUrl===url);
    if(!images.length&&existing?.images?.length)images=existing.images;
    res.json({ok:true,existingId:existing?.id||null,blocked,product:{
      id:existing?.id||makeId(),sourceUrl:finalUrl,originalUrl:url,name:title,image:images[0]||'',images,
      description,sourcePrice,caayoPrice:Number(req.body?.caayoPrice||existing?.caayoPrice||0),
      category:cleanText(req.body?.category||existing?.category||'New finds'),active:existing?existing.active!==false:true
    },note:blocked
      ?'The website did not give us the product details (Pinduoduo often blocks servers). Type the name and description, then tap Translate. Your uploaded photos are kept.'
      :`Imported the name, description${extra.details.length?`, ${extra.details.length} detail line${extra.details.length===1?'':'s'}`:''}${sourcePrice?' and price':''}${images.length?` and ${images.length} image${images.length===1?'':'s'}`:''}. Anything not in English was translated. Review the text, upload your photos and set your CAAYO price.`,
      translationNote:''});
  }catch(err){res.status(502).json({error:'Could not read this link automatically.',detail:err.message,fallback:'The site may be blocking automated requests. Keep the URL and use the manual product fields in the admin form.'});}
});

app.post('/api/admin/products', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const products = readJson(PRODUCTS_FILE);
  const product = {
    id: cleanText(body.id) || makeId(),
    sourceUrl: cleanText(body.sourceUrl),
    originalUrl: cleanText(body.originalUrl),
    name: await toEnglish(escapeHtmlText(body.name)) || 'Untitled product',
    image: cleanText(body.image) || (Array.isArray(body.images) ? cleanText(body.images[0]) : ''),
    images: uniqueImages([cleanText(body.image), ...(Array.isArray(body.images) ? body.images : [])]),
    description: await toEnglish(cleanMultiline(body.description)),
    sourcePrice: Number(body.sourcePrice || 0),
    caayoPrice: Number(body.caayoPrice || 0),
    category: escapeHtmlText(body.category) || 'New finds',
    rating: Number(body.rating) > 0 ? Math.min(5, Number(body.rating)) : undefined,
    reviews: escapeHtmlText(body.reviews || ''),
    active: body.active !== false,
    updatedAt: new Date().toISOString()
  };
  if (!product.caayoPrice || product.caayoPrice < 0) return res.status(400).json({ error: 'Enter a CAAYO selling price.' });
  const idx = products.findIndex(p => p.id === product.id || (product.sourceUrl && p.sourceUrl === product.sourceUrl));
  if (idx >= 0) products[idx] = { ...products[idx], ...product };
  else products.unshift({ ...product, createdAt: new Date().toISOString() });
  writeJson(PRODUCTS_FILE, products);
  res.json({ ok: true, product });
});

app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  const products = readJson(PRODUCTS_FILE);
  const next = products.filter(p => String(p.id) !== String(req.params.id));
  writeJson(PRODUCTS_FILE, next);
  res.json({ ok: true });
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  res.json({ orders: readJson(ORDERS_FILE) });
});

// Public single-product endpoint.
app.get('/api/products/:id', (req, res) => {
  const p = readJson(PRODUCTS_FILE).find(x => String(x.id) === String(req.params.id) && x.active !== false);
  if (!p) return res.status(404).json({ error: 'Product not found' });
  res.json({ product: p });
});

// Order endpoint used by the storefront checkout. Prices are always taken from the server, never the browser.
app.post('/api/orders', (req, res) => {
  const body = req.body || {};
  const products = readJson(PRODUCTS_FILE);
  const lines = [];
  for (const it of Array.isArray(body.items) ? body.items : []) {
    const qty = Math.max(1, Math.min(99, parseInt(it.quantity, 10) || 0));
    const p = products.find(x => String(x.id) === String(it.id));
    if (p && qty) lines.push({ id: p.id, name: p.name, price: Number(p.caayoPrice) || 0, quantity: qty });
  }
  const c = body.customer || {};
  if (!lines.length) return res.status(400).json({ error: 'Your cart has no available products. Refresh and try again.' });
  if (!cleanText(c.name) || !cleanText(c.phone) || !cleanText(c.address)) return res.status(400).json({ error: 'Name, phone and address are required.' });
  const total = lines.reduce((sum, l) => sum + l.price * l.quantity, 0);
  const order = {
    id: 'ORD-' + Date.now(),
    email: cleanText(body.email),
    customer: { name: cleanText(c.name), phone: cleanText(c.phone), state: cleanText(c.state), city: cleanText(c.city), address: cleanText(c.address) },
    lines, total, status: 'pending', createdAt: new Date().toISOString()
  };
  const orders = readJson(ORDERS_FILE);
  orders.unshift(order);
  writeJson(ORDERS_FILE, orders);
  res.json({ ok: true, orderId: order.id, total, message: 'Order received. Payment gateway can be connected here.' });
});

app.get('/health', (req, res) => res.json({ ok: true, products: readJson(PRODUCTS_FILE).length }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`CAAYO running on 0.0.0.0:${PORT}`);
});
