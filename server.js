const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-this-password';
const DATA_DIR = path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PRODUCTS_FILE)) fs.writeFileSync(PRODUCTS_FILE, '[]');
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]');

app.use(express.json({ limit: '2mb' }));
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

app.use(express.static(__dirname, { index: 'index.html' }));
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
async function fetchProductPage(inputUrl) {
  const response=await fetch(inputUrl,{redirect:'follow',headers:{
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language':'en-US,en;q=0.9,zh-CN;q=0.8','Cache-Control':'no-cache'
  },signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(`Pinduoduo returned HTTP ${response.status}`);
  return {html:await response.text(),finalUrl:response.url||inputUrl};
}

// Simple admin session token. For production, put the site behind HTTPS.
const adminTokens = new Set();
function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.body?.token || req.query?.token;
  if (!token || !adminTokens.has(token)) return res.status(401).json({ error: 'Admin login required' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  if (!req.body?.password || req.body.password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  adminTokens.add(token);
  res.json({ token });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.body?.token;
  adminTokens.delete(token);
  res.json({ ok: true });
});

// Public storefront product endpoint used by index.html.
app.get('/api/products', (req, res) => {
  let products = readJson(PRODUCTS_FILE).filter(p => p.active !== false);
  const q = cleanText(req.query.q).toLowerCase();
  if (q) products = products.filter(p => `${p.name} ${p.category}`.toLowerCase().includes(q));
  res.json({ products });
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
    const images=uniqueImages([ogImage,...jsonLd.imageUrls,...embedded.imageUrls,...extractAttrImages(html,finalUrl)]);
    const title=escapeHtmlText(ogTitle||jsonLd.title||embedded.title||'Imported Pinduoduo product');
    const description=escapeHtmlText(embedded.description||jsonLd.description||ogDescription||metaDescription||'');
    const sourcePrice=Number(embedded.sourcePrice||jsonLd.sourcePrice||req.body?.sourcePrice||0);
    const products=readJson(PRODUCTS_FILE);
    const existing=products.find(p=>p.sourceUrl===url||p.sourceUrl===finalUrl||p.originalUrl===url);
    res.json({ok:true,existingId:existing?.id||null,product:{
      id:existing?.id||makeId(),sourceUrl:finalUrl,originalUrl:url,name:title,image:images[0]||'',images,
      description,sourcePrice,caayoPrice:Number(req.body?.caayoPrice||existing?.caayoPrice||0),
      category:cleanText(req.body?.category||existing?.category||'New finds'),active:existing?existing.active!==false:true
    },note:images.length?`Imported ${images.length} product image${images.length===1?'':'s'}. Review the title, description and CAAYO price before publishing.`:'The page did not expose usable product images. You can paste image URLs manually below.',translationNote:'No translation API is used. If the source exposes Chinese-only text, edit the description in English before publishing.'});
  }catch(err){res.status(502).json({error:'Could not read this Pinduoduo page automatically.',detail:err.message,fallback:'The site may be blocking automated requests. Keep the URL and use the manual product fields in the admin form.'});}
});

app.post('/api/admin/products', requireAdmin, (req, res) => {
  const body = req.body || {};
  const products = readJson(PRODUCTS_FILE);
  const product = {
    id: cleanText(body.id) || makeId(),
    sourceUrl: cleanText(body.sourceUrl),
    originalUrl: cleanText(body.originalUrl),
    name: escapeHtmlText(body.name) || 'Untitled product',
    image: cleanText(body.image) || (Array.isArray(body.images) ? cleanText(body.images[0]) : ''),
    images: uniqueImages([cleanText(body.image), ...(Array.isArray(body.images) ? body.images : [])]),
    description: escapeHtmlText(body.description),
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
