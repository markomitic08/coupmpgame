# Coup Multiplayer (Node.js + Colyseus)

## Lokalno pokretanje
1. `npm install`
2. `npm start`
3. Otvori `http://localhost:3000` u pregledaču.

## Deploy na Render.com (Free)
1. Postavi fajlove (`package.json`, `server.js`, `public/index.html`) na GitHub repozitorijum.
2. Na Render.com izaberi **New + -> Web Service** i poveži repozitorijum.
3. Podešavanja:
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free`
