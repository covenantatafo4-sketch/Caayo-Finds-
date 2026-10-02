const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
  const pm=html.match(/["'](?:price|goods_price|min_group_price)["']\s*:\s*["']?([0-9]+(?:\\.[0-9]+)?)/i);
  if(pm)sourcePrice=Number(pm[1])||0;
  const arrayRe=/["'](?:item_imgs|itemImages|gallery|galleryImages|goods_gallery|detail_imgs)["']\s*:\s*\[([\s\S]{0,50000}?)\]/gi;
  for(const m of html.matchAll(arrayRe)){
    for(const u of m[1].matchAll(/["'](https?:\/\/[^"']+)["']/g)){
      const a=absoluteUrl(u[1],baseUrl); if(a)images.push(a);
    }
  }
  return {title,description,sourcePrice,imageUrls:uniqueImages(images)};
}
// ---------- Page fetching (tries a mobile browser first, like the Pinduoduo app does) ----------
const UA_MOBILE = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
function mobileUrl(inputUrl) {
  try {
    const u = new URL(inputUrl);
    const id = u.searchParams.get('goods_id');
    if (id && /yangkeduo|pinduoduo/i.test(u.hostname)) return 'https://mobile.yangkeduo.com/goods.html?goods_id=' + encodeURIComponent(id);
  } catch {}
  return inputUrl;
}
async function fetchOnce(url, ua) {
  const r = await fetch(url, { redirect: 'follow', headers: {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
    'Referer': 'https://mobile.yangkeduo.com/'
  }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Pinduoduo returned HTTP ${r.status}`);
  return { html: await r.text(), finalUrl: r.url || url };
}
async function fetchProductPage(inputUrl) {
  const attempts = [[mobileUrl(inputUrl), UA_MOBILE], [inputUrl, UA_MOBILE], [inputUrl, UA_DESKTOP]];
  let last = null, lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const [u, ua] = attempts[i];
    try {
      const res = await fetchOnce(u, ua);
      last = res;
      if (/window\.rawData|goods_name|goodsName/.test(res.html)) return res;
      const m = mobileUrl(res.finalUrl);   // short links: retry using the goods_id they redirect to
      if (m !== u && !attempts.some(a => a[0] === m)) attempts.push([m, UA_MOBILE]);
    } catch (e) { lastErr = e; }
  }
  if (last) return last;
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
function readRawData(raw, baseUrl) {
  const out = { title: '', description: '', sourcePrice: 0, imageUrls: [] };
  if (!raw) return out;
  const walk = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 8) return;
    if (!out.title && typeof o.goodsName === 'string') out.title = cleanText(o.goodsName);
    if (!out.title && typeof o.goods_name === 'string') out.title = cleanText(o.goods_name);
    if (!out.description && typeof o.goodsDesc === 'string') out.description = stripHtml(o.goodsDesc);
    for (const k of ['minGroupPrice', 'min_group_price', 'minOnSaleGroupPrice']) {
      if (!out.sourcePrice && Number(o[k]) > 0) out.sourcePrice = Number(o[k]) / 100;   // prices are in fen
    }
    for (const k of ['topGallery', 'gallery', 'viewImageData', 'detailGallery']) {
      if (!Array.isArray(o[k])) continue;
      for (const g of o[k]) {
        const u = typeof g === 'string' ? g : (g && (g.url || g.hdUrl || g.hdThumbUrl || g.thumbUrl || g.imageUrl));
        if (u) out.imageUrls.push(absoluteUrl(u, baseUrl));
      }
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  walk(raw);
  out.imageUrls = uniqueImages(out.imageUrls).slice(0, 12);
  return out;
}
function publicBase(req) {
  return (process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'))).replace(/\/$/, '');
}
// Download imported photos to our own server so they never break (Pinduoduo blocks hot-linking).
async function mirrorImages(urls, base) {
  return Promise.all(urls.slice(0, 10).map(async url => {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA_DESKTOP, 'Referer': 'https://mobile.yangkeduo.com/' }, signal: AbortSignal.timeout(12000) });
      const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[type];
      if (!r.ok || !ext) return url;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 2000 || buf.length > 3 * 1024 * 1024) return url;
      const file = makeId() + '.' + ext;
      fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
      return base + '/uploads/' + file;
    } catch { return url; }
  }));
}

// ---------- Chinese -> English ----------
// Uses Google Cloud Translation if GOOGLE_TRANSLATE_API_KEY is set, otherwise the free MyMemory service
// (optionally set MYMEMORY_EMAIL to raise its free daily limit).
const hasChinese = s => /[\u3400-\u9fff\uf900-\ufaff]/.test(String(s || ''));
const trCache = new Map();
function chunkText(text, max = 450) {
  const parts = []; let cur = '';
  for (const piece of String(text).split(/(?<=[。！？!?；;\n])/)) {
    if (cur && (cur + piece).length > max) { parts.push(cur); cur = ''; }
    if (piece.length > max) { for (let i = 0; i < piece.length; i += max) parts.push(piece.slice(i, i + max)); }
    else cur += piece;
  }
  if (cur) parts.push(cur);
  return parts;
}
async function translateChunk(q) {
  const key = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (key) {
    const r = await fetch('https://translation.googleapis.com/language/translate/v2?key=' + encodeURIComponent(key), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q, source: 'zh', target: 'en', format: 'text' }), signal: AbortSignal.timeout(10000)
    });
    const d = await r.json();
    const t = d && d.data && d.data.translations && d.data.translations[0] && d.data.translations[0].translatedText;
    if (!r.ok || !t) throw new Error('Google translation failed');
    return t;
  }
  const de = process.env.MYMEMORY_EMAIL ? '&de=' + encodeURIComponent(process.env.MYMEMORY_EMAIL) : '';
  const r = await fetch('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q) + '&langpair=zh-CN|en' + de, { signal: AbortSignal.timeout(10000) });
  const d = await r.json();
  const t = d && d.responseData && d.responseData.translatedText;
  if (!r.ok || !t || /MYMEMORY WARNING|INVALID|QUERY LENGTH/i.test(t)) throw new Error('MyMemory translation failed or limit reached');
  return t;
}
async function toEnglish(text) {
  const s = String(text || '').trim();
  if (!s || !hasChinese(s)) return s;
  if (trCache.has(s)) return trCache.get(s);
  try {
    const out = [];
    for (const c of chunkText(s)) out.push(hasChinese(c) ? await translateChunk(c) : c);
    const t = cleanText(out.join(' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    if (t) { trCache.set(s, t); if (trCache.size > 2000) trCache.delete(trCache.keys().next().value); return t; }
  } catch (e) { console.warn('Translation failed:', e.message); }
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
    if (typeof req.body?.[k] === 'string') out[k] = await toEnglish(req.body[k].slice(0, 3000));
  }
  res.json({ ok: true, ...out });
});

// Public storefront product endpoint used by index.html.
app.get('/api/products', async (req, res) => {
  let products = readJson(PRODUCTS_FILE).filter(p => p.active !== false);
  products = await Promise.all(products.map(async p => (hasChinese(p.name) || hasChinese(p.description))
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
  if(!validPddUrl(url))return res.status(400).json({error:'Please enter a valid Pinduoduo/Yangkeduo product URL.'});
  try{
    const {html,finalUrl}=await fetchProductPage(url);
    const ogTitle=extractMeta(html,'og:title');
    const metaDescription=extractMeta(html,'description','name');
    const ogDescription=extractMeta(html,'og:description');
    const ogImage=absoluteUrl(extractMeta(html,'og:image'),finalUrl);
    const jsonLd=collectJsonLd(html,finalUrl);
    const embedded=extractEmbeddedPddData(html,finalUrl);
    const raw=readRawData(extractRawData(html),finalUrl);
    const isLogo=u=>/share_logo|\/base\/|favicon|logo\.(png|jpg|webp)/i.test(u||'');
    let images=uniqueImages([...raw.imageUrls,ogImage,...jsonLd.imageUrls,...embedded.imageUrls,...extractAttrImages(html,finalUrl)]).filter(u=>!isLogo(u));
    const generic=!raw.title&&/拼多多商城|^pinduoduo$/i.test((ogTitle||'').trim())&&!images.length;
    const rawTitle=generic?'':(raw.title||ogTitle||jsonLd.title||embedded.title||'');
    const rawDesc=raw.description||embedded.description||jsonLd.description||ogDescription||metaDescription||'';
    const title=await toEnglish(escapeHtmlText(rawTitle))||(generic?'':'Imported Pinduoduo product');
    const description=await toEnglish(escapeHtmlText(rawDesc));
    images=await mirrorImages(images,publicBase(req));
    const sourcePrice=Number(raw.sourcePrice||embedded.sourcePrice||jsonLd.sourcePrice||req.body?.sourcePrice||0);
    const products=readJson(PRODUCTS_FILE);
    const existing=products.find(p=>p.sourceUrl===url||p.sourceUrl===finalUrl||p.originalUrl===url);
    res.json({ok:true,existingId:existing?.id||null,product:{
      id:existing?.id||makeId(),sourceUrl:finalUrl,originalUrl:url,name:title,image:images[0]||'',images,
      description,sourcePrice,caayoPrice:Number(req.body?.caayoPrice||existing?.caayoPrice||0),
      category:cleanText(req.body?.category||existing?.category||'New finds'),active:existing?existing.active!==false:true
    },note:images.length?`Imported ${images.length} product image${images.length===1?'':'s'}. Review the title, description and CAAYO price before publishing.`:(generic?'Pinduoduo blocked the automatic import (it returned its generic home page). Upload the product photos and paste the name below; Chinese text is translated to English for you.':'The page did not expose usable product images. Upload the photos below.'),translationNote:'Chinese text is translated to English automatically. Please review it.'});
  }catch(err){res.status(502).json({error:'Could not read this Pinduoduo page automatically.',detail:err.message,fallback:'The site may be blocking automated requests. Keep the URL and use the manual product fields in the admin form.'});}
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
    description: await toEnglish(escapeHtmlText(body.description)),
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
