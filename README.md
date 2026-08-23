# IG Public Media Downloader

A small, security-focused Node.js/Express project for downloading **public/authorized** Instagram media through a provider API that you are permitted to use.

## What it does

1. User pastes an Instagram HTTPS URL.
2. Browser sends the URL to `/api/media`.
3. Backend validates the hostname.
4. Backend calls the configured media provider.
5. Backend returns a thumbnail URL and/or video URL.
6. Browser shows two download actions.

## Important

This project intentionally does **not** scrape Instagram directly or bypass login, private accounts, anti-bot systems, rate limits, or other access controls.

## API provider

This version is wired to FastSaverAPI's public-media endpoint. Their current documentation says the free tier has 1,000 credits, with 1.5 credits for a post/reel/album and 5 credits for stories/highlights; Free is rate-limited to 10 requests/minute. Public content only. citeturn2view0

Create a FastSaver API key and put it only in `.env`:

```env
FASTSAVER_API_KEY=your_secret_key
```

The backend calls:

`GET https://api.fastsaver.io/v1/fetch?url=...`

with the `X-Api-Key` header. The provider returns `download_url` and `thumbnail_url` for supported public media. Signed CDN URLs are temporary, so the app uses them promptly rather than storing them. citeturn2view0

For albums/carousels, this starter UI shows the first downloadable item. You can extend it later to show all slides.

Only HTTPS media URLs are accepted.

## Run locally

Install Node.js 20+.

```bash
npm install
```

Copy `.env.example` to `.env` and set:

```env
MEDIA_PROVIDER_URL=...
MEDIA_PROVIDER_API_KEY=...
```

Then:

```bash
npm start
```

Open `http://localhost:3000`.

## Security included

- Helmet security headers
- Strict Instagram URL validation
- HTTPS-only returned media URLs
- CORS allow-list
- JSON body size limit
- Per-IP API rate limiting
- Provider request timeout
- API key kept server-side in `.env`
- No arbitrary URL proxy/download endpoint
- No private-content or access-control bypass

## Production notes

- Put the app behind HTTPS.
- Use a real secret manager for the provider key.
- Set `FRONTEND_ORIGIN` to your exact production origin.
- If you run multiple backend instances, use a shared rate-limit store.
- Check your provider's terms and Instagram/Meta terms before launch.


## Download behavior

The browser now receives a short-lived server-side download ticket instead of the
provider's cross-origin CDN URL. The backend fetches that provider URL and sends
`Content-Disposition: attachment`, which makes the Download Video/Thumbnail
buttons behave like actual downloads on browsers that honor attachment responses,
including mobile browsers. Tickets expire after 10 minutes and are one-use.


### v5 fix

The thumbnail is now fetched by the Node backend from the Instagram CDN and served back from `/api/thumbnail/...` as an inline image. The browser no longer tries to hotlink the signed Instagram thumbnail URL.

The video button uses a same-origin `/api/download/...` endpoint with `Content-Disposition: attachment`, so mobile browsers should request the file instead of simply opening the external MP4 player.

Both proxy endpoints only accept HTTPS URLs on `*.cdninstagram.com`, and their tickets expire after 10 minutes.


### v6 provider CDN compatibility

FastSaver's current examples show Instagram media on `*.cdninstagram.com`, but CDN hostnames can also use Meta's `*.fbcdn.net` family. The server now permits only HTTPS media URLs on those two CDN families, then validates the final URL after redirects. This fixes false "No downloadable public media was returned" errors caused by an overly narrow CDN allow-list while retaining SSRF protection.


### v7 final provider fix

This version uses FastSaver's documented current Instagram endpoint:
`GET https://api.fastsaver.io/v1/fetch?url=...` with `X-Api-Key`. The timeout is 60 seconds, matching the provider's current examples, and provider `detail` errors are surfaced in the local UI so an invalid/expired key, rate limit, unsupported/deleted post, or other provider issue is no longer hidden behind a generic message.
