# CAAYO — Pinduoduo URL Product Importer

This version does **not** contain a Pinduoduo API-key/credentials feature.

## How it works
1. Open `/admin`.
2. Log in with your admin password.
3. Paste a Pinduoduo/Yangkeduo product link.
4. Click **IMPORT LINK**.
5. The backend tries to read public product metadata (title, image, description).
6. Enter/edit the CAAYO selling price.
7. Click **PUBLISH TO CAAYO**.
8. The product is stored in `data/products.json` and becomes available on the main storefront through `/api/products`.

## Important
Pinduoduo may block automated requests or hide product data behind JavaScript/login/anti-bot checks. This importer does not bypass those protections. If extraction fails, use the same admin form to enter the product information manually while keeping the source URL.

## Local setup
Install Node.js, then in this folder:

```bash
npm install
```

Set an admin password before starting:

Linux/macOS:
```bash
ADMIN_PASSWORD="your-strong-password" npm start
```

Windows PowerShell:
```powershell
$env:ADMIN_PASSWORD="your-strong-password"; npm start
```

Then open:
- Storefront: `http://localhost:3000/`
- Admin: `http://localhost:3000/admin`

## Cloudflare
If you use Cloudflare, deploy the Node.js backend on a Node-compatible host/server. A normal static Cloudflare Pages deployment cannot run this Express server by itself. Your frontend can call the backend URL, or you can place the backend behind the same domain/reverse proxy.
