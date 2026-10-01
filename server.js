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
app.use(express.static(__dirname, { index: 'index.html' }));

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

// Import product data from a Pinduoduo product URL. No Pinduoduo API key is used.
app.post('/api/admin/import-url', requireAdmin, async (req, res) => {
  const url = cleanText(req.body?.url);
  if (!validPddUrl(url)) return res.status(400).json({ error: 'Please enter a valid Pinduoduo/Yangkeduo product URL.' });

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Pinduoduo returned HTTP ${response.status}`);
    const html = await response.text();

    const meta = (property, name) => {
      const re = name
        ? new RegExp(`<meta[^>]+(?:name=["']${name}["'][^>]*content=["']([^"']+)["']|content=["']([^"']+)["'][^>]*name=["']${name}["'])[^>]*>`, 'i')
        : new RegExp(`<meta[^>]+(?:property=["']${property}["'][^>]*content=["']([^"']+)["']|content=["']([^"']+)["'][^>]*property=["']${property}["'])[^>]*>`, 'i');
      const m = html.match(re); return cleanText(m?.[1] || m?.[2] || '');
    };
    const decode = s => String(s || '').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');

    let title = decode(meta('og:title')) || decode(meta('', 'title'));
    let image = decode(meta('og:image'));
    let description = decode(meta('og:description'));

    // JSON-LD is often present on commerce pages.
    const jsonLdMatches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    for (const match of jsonLdMatches) {
      try {
        const raw = match[1].trim();
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of list) {
          if (!title && item.name) title = cleanText(item.name);
          if (!description && item.description) description = cleanText(item.description);
          if (!image && item.image) image = Array.isArray(item.image) ? item.image[0] : item.image;
          if (item.offers?.price && !req.body?.sourcePrice) req.body.sourcePrice = item.offers.price;
        }
      } catch {}
    }

    // Common image fallback. This does not attempt to bypass login/anti-bot protection.
    if (!image) {
      const img = html.match(/https?:\\?\/\\?\/[^"'\\s<>]+\.(?:jpg|jpeg|png|webp)(?:\?[^"'\\s<>]*)?/i);
      if (img) image = img[0].replace(/\\/g, '');
    }

    title = escapeHtmlText(title) || 'Imported Pinduoduo product';
    description = escapeHtmlText(description);
    const products = readJson(PRODUCTS_FILE);
    const existing = products.find(p => p.sourceUrl === url);

    res.json({
      ok: true,
      existingId: existing?.id || null,
      product: {
        id: existing?.id || makeId(),
        sourceUrl: url,
        name: title,
        image,
        description,
        sourcePrice: Number(req.body?.sourcePrice || 0),
        caayoPrice: Number(req.body?.caayoPrice || existing?.caayoPrice || 0),
        category: cleanText(req.body?.category || existing?.category || 'New finds'),
        active: existing ? existing.active !== false : true
      },
      note: image || title !== 'Imported Pinduoduo product'
        ? 'Product information was extracted from the public page. Review it before publishing.'
        : 'Pinduoduo did not expose usable product data to the importer. You can fill the fields manually.'
    });
  } catch (err) {
    res.status(502).json({
      error: 'Could not read this Pinduoduo page automatically.',
      detail: err.message,
      fallback: 'Keep the URL and enter the product name/image/CAAYO price manually in the admin form.'
    });
  }
});

app.post('/api/admin/products', requireAdmin, (req, res) => {
  const body = req.body || {};
  const products = readJson(PRODUCTS_FILE);
  const product = {
    id: cleanText(body.id) || makeId(),
    sourceUrl: cleanText(body.sourceUrl),
    name: escapeHtmlText(body.name) || 'Untitled product',
    image: cleanText(body.image),
    description: escapeHtmlText(body.description),
    sourcePrice: Number(body.sourcePrice || 0),
    caayoPrice: Number(body.caayoPrice || 0),
    category: escapeHtmlText(body.category) || 'New finds',
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

// Placeholder order endpoint: compatible with the existing frontend while Paystack is added later.
app.post('/api/orders', (req, res) => {
  const order = { id: 'ORD-' + Date.now(), ...req.body, status: 'pending', createdAt: new Date().toISOString() };
  const orders = readJson(ORDERS_FILE);
  orders.unshift(order);
  writeJson(ORDERS_FILE, orders);
  res.json({ ok: true, orderId: order.id, message: 'Order created. Payment gateway can be connected here.' });
});

app.get('/health', (req, res) => res.json({ ok: true, products: readJson(PRODUCTS_FILE).length }));

app.listen(PORT, () => console.log(`CAAYO running on http://localhost:${PORT}`));
