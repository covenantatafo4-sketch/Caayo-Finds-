# CAAYO — Ecommerce Store

CAAYO is a black-and-white ecommerce storefront with an admin panel for importing products from public Pinduoduo/Yangkeduo URLs. No Pinduoduo API key is required.

## Files
- `index.html` — customer storefront (mobile-first, matches the CAAYO app design): menu drawer, live search, hero slider, 5 category tiles, Under #1000 row with See All, product detail sheet, cart drawer, checkout, account/orders and a 5-tab bottom nav. Products come from the backend; if it has none (or is unreachable) four demo products are shown.
- `admin.html` — admin login, product URL importer, image gallery preview, editing, publishing, hide/show, rating fields and an Orders list.
- `server.js` — Express backend, product/order APIs (orders are priced server-side) and URL importer.
- `package.json` — Node/Express dependencies and start command.
- `README-CAAYO.md` — setup instructions.

## Product workflow
1. Open `/admin`.
2. Log in with `ADMIN_PASSWORD`.
3. Paste a Pinduoduo/Yangkeduo product URL.
4. Click **IMPORT LINK**.
5. The backend attempts to resolve the URL and extract title, description, main image, additional gallery images and source price when publicly available.
6. Review/edit the imported information and set the CAAYO selling price.
7. Click **PUBLISH TO CAAYO**.
8. The storefront loads the published product and its image(s) from `/api/products`.

## Product images
Product imagery is not hard-coded into the storefront. The storefront uses the image data supplied by the backend (`image` and `images`). Each product's images can therefore come from the product URL imported in the admin panel. If the source page does not expose usable images, image URLs can be entered manually in the admin panel.

## Categories
The storefront includes Accessories, Men Clothing, Gadgets, Women Clothing and Under ₦1,000. Use matching category values when publishing products.

## Local setup
```bash
npm install
ADMIN_PASSWORD="your-strong-password" npm start
```
Storefront: `http://localhost:3000/`
Admin: `http://localhost:3000/admin`

## Render
Build Command: `npm install`
Start Command: `npm start`
Set `ADMIN_PASSWORD` in Render Environment Variables. The server binds to `0.0.0.0` and uses Render's `PORT`.

## Cloudflare frontend
When served from localhost or onrender.com the storefront uses the same origin. Otherwise it points API requests to `https://caayo-finds.onrender.com`. If the backend URL changes, update `CAAYO_API` in `index.html`. Keep the Express backend on a Node-compatible host.

## Importer limitation
Pinduoduo/Yangkeduo can restrict automated requests or hide data behind JavaScript, login or anti-bot protections. This importer does not bypass those protections. If automatic extraction fails, use the manual product fields while keeping the source URL.

## Storage
The backend creates `data/products.json` and `data/orders.json` automatically. JSON storage is suitable for the current prototype/testing stage; move to persistent database storage for a larger production deployment.
