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


## Security and translation (latest update)

- The admin panel is only reachable by typing `/admin` in the address bar. The storefront has no link to it.
- **You must set `ADMIN_PASSWORD`** on your server (Render > Environment). Until you do, admin login is disabled.
- Admin login allows 5 wrong tries, then locks that device for 15 minutes. Sessions last 12 hours and end when the browser tab closes.
- `server.js` serves only the storefront, `/admin` and `/uploads`. Your code and order data are no longer public.
- Chinese product names and descriptions are translated to English when you import or publish, and again on the storefront for any older product. By default this uses the free MyMemory service. For better quality and no daily limit, set `GOOGLE_TRANSLATE_API_KEY` (Google Cloud Translation). Optional: `MYMEMORY_EMAIL` raises MyMemory's free limit.
- Imported product photos are copied to your own server so they do not break. Set `UPLOAD_DIR` to a persistent disk to keep them across redeploys.

## Link import (latest)

- Paste any public product link in admin (Pinduoduo, 1688, AliExpress or a normal shop). The server pulls the name, description, detail lines (material, colour, options, seller, sales), price and keywords. It does not import photos; you upload your own.
- Anything not in English is translated automatically. The order is Google Cloud Translation (if `GOOGLE_TRANSLATE_API_KEY` is set), then Google's free web endpoint, then MyMemory. The free web endpoint is unofficial, so add the API key for a dependable setup.
- Pinduoduo often refuses requests from servers. When that happens admin tells you, and you type the name and description yourself; the Translate button converts them to English.
