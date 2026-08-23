const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const dotenv = require("dotenv");
const { z } = require("zod");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || `http://localhost:${PORT}`;

app.disable("x-powered-by");

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
  })
);

app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"]
  })
);

app.use(express.json({ limit: "16kb" }));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many requests. Try again in a minute." }
});


const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many download requests. Try again in a minute." }
});

// Temporary server-side download tickets.
// The browser never receives an arbitrary proxy URL; it gets a random ticket
// that maps to a URL returned by the configured media provider.
const downloadTickets = new Map();
const TICKET_TTL_MS = 10 * 60 * 1000;

function createDownloadTicket(url, filename, mode = "download") {
  if (!url) return null;
  const ticket = crypto.randomBytes(24).toString("hex");
  downloadTickets.set(ticket, {
    url,
    filename,
    mode,
    expiresAt: Date.now() + TICKET_TTL_MS
  });
  return ticket;
}

function cleanFilename(name, fallback) {
  const value = String(name || fallback)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return value || fallback;
}

setInterval(() => {
  const now = Date.now();
  for (const [ticket, item] of downloadTickets) {
    if (item.expiresAt <= now) downloadTickets.delete(ticket);
  }
}, 60_000).unref();

const instagramUrlSchema = z.string().trim().url().refine((value) => {
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return (host === "instagram.com" || host.endsWith(".instagram.com"))
      && (u.protocol === "https:" || u.protocol === "http:");
  } catch {
    return false;
  }
}, "Only Instagram URLs are accepted.");

const requestSchema = z.object({
  url: instagramUrlSchema
});

function isAllowedMediaHost(hostname) {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return (
    host === "cdninstagram.com" ||
    host.endsWith(".cdninstagram.com") ||
    host === "fbcdn.net" ||
    host.endsWith(".fbcdn.net")
  );
}

function safeProviderUrl(value) {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || !isAllowedMediaHost(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function callProvider(instagramUrl) {
  const apiKey = process.env.FASTSAVER_API_KEY;

  if (!apiKey) {
    const err = new Error("MEDIA_PROVIDER_NOT_CONFIGURED");
    err.status = 503;
    throw err;
  }

  const endpoint = "https://api.fastsaver.io/v1/fetch";
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Number(process.env.MEDIA_PROVIDER_TIMEOUT_MS || 60000)
  );

  try {
    const providerUrl = `${endpoint}?url=${encodeURIComponent(instagramUrl)}`;

    const response = await fetch(providerUrl, {
      method: "GET",
      headers: {
        "X-Api-Key": apiKey,
        "Accept": "application/json"
      },
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || data.ok !== true) {
      const err = new Error(
        typeof data.detail === "string"
          ? data.detail.slice(0, 300)
          : `Provider returned HTTP ${response.status}`
      );
      err.status = response.status === 404 ? 404 : (response.status === 401 || response.status === 403 ? 502 : 502);
      throw err;
    }

    // Albums/carousels can contain multiple items. The simple UI uses
    // the first downloadable item for now.
    const first = data.type === "album" && Array.isArray(data.items)
      ? data.items.find((item) => item && (item.download_url || item.thumbnail_url))
      : data;

    const result = {
      title: typeof data.caption === "string" ? data.caption.slice(0, 200) : "",
      videoUrl: safeProviderUrl(first?.type === "video" ? first.download_url : null),
      thumbnailUrl: safeProviderUrl(first?.thumbnail_url || data.thumbnail_url),
      type: first?.type || data.type || "unknown",
      width: Number.isFinite(first?.width) ? first.width : data.width,
      height: Number.isFinite(first?.height) ? first.height : data.height,
      duration: Number.isFinite(first?.duration) ? first.duration : data.duration
    };

    if (!result.videoUrl && !result.thumbnailUrl) {
      const err = new Error("NO_MEDIA_RETURNED");
      err.status = 404;
      throw err;
    }

    return result;
  } finally {
    clearTimeout(timeout);
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/media", apiLimiter, async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Please provide a valid Instagram URL."
    });
  }

  try {
    const media = await callProvider(parsed.data.url);
    const baseName = cleanFilename(media.title || "instagram-media", "instagram-media");

    const videoTicket = media.videoUrl
      ? createDownloadTicket(media.videoUrl, `${baseName}.mp4`, "download")
      : null;

    const thumbnailTicket = media.thumbnailUrl
      ? createDownloadTicket(media.thumbnailUrl, `${baseName}.jpg`, "thumbnail")
      : null;

    return res.json({
      title: media.title,
      type: media.type,
      width: media.width,
      height: media.height,
      duration: media.duration,

      // Same-origin URLs: the browser can display the thumbnail and
      // the server can force the MP4 to download.
      thumbnailUrl: thumbnailTicket ? `/api/thumbnail/${thumbnailTicket}` : null,
      thumbnailDownloadUrl: thumbnailTicket ? `/api/thumbnail/${thumbnailTicket}?download=1` : null,
      videoUrl: videoTicket ? `/api/download/${videoTicket}` : null
    });
  } catch (error) {
    if (error.name === "AbortError") {
      return res.status(504).json({ error: "Media provider timed out." });
    }

    if (error.status === 503) {
      return res.status(503).json({
        error: "Media provider is not configured. Add provider settings to .env."
      });
    }

    if (error.status === 404) {
      return res.status(404).json({
        error: "No downloadable public media was returned."
      });
    }

    console.error("Provider error:", error.message);

    return res.status(502).json({
      error: `Could not retrieve media: ${error.message || "provider request failed"}`
    });
  }
});

async function streamTicket(req, res, expectedMode) {
  const item = downloadTickets.get(req.params.ticket);

  if (!item || item.expiresAt <= Date.now() || item.mode !== expectedMode) {
    if (item && item.expiresAt <= Date.now()) downloadTickets.delete(req.params.ticket);
    return res.status(404).json({ error: "Media link expired. Fetch the media again." });
  }

  try {
    const target = new URL(item.url);

    if (target.protocol !== "https:" || !isAllowedMediaHost(target.hostname)) {
      return res.status(400).json({ error: "Invalid media source." });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    let upstream;
    try {
      upstream = await fetch(target, {
        method: "GET",
        headers: {
          "User-Agent": "IG-Public-Media-Downloader/1.0",
          "Accept": expectedMode === "thumbnail" ? "image/*" : "video/mp4,video/*,*/*;q=0.8"
        },
        redirect: "follow",
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    try {
      const finalUrl = new URL(upstream.url);
      if (finalUrl.protocol !== "https:" || !isAllowedMediaHost(finalUrl.hostname)) {
        return res.status(502).json({ error: "Media CDN redirect was rejected." });
      }
    } catch {
      return res.status(502).json({ error: "Invalid media CDN response." });
    }

    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: "Instagram CDN could not be reached." });
    }

    const contentType = upstream.headers.get("content-type") ||
      (expectedMode === "thumbnail" ? "image/jpeg" : "video/mp4");

    res.status(200);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (expectedMode === "download") {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${cleanFilename(item.filename, "instagram-media.mp4")}"`
      );
    } else {
      const forceDownload = req.query.download === "1";
      res.setHeader(
        "Content-Disposition",
        `${forceDownload ? "attachment" : "inline"}; filename="${cleanFilename(item.filename, "instagram-thumbnail.jpg")}"`
      );
    }

    const contentLength = upstream.headers.get("content-length");
    if (contentLength) res.setHeader("Content-Length", contentLength);

    await Readable.fromWeb(upstream.body).pipe(res);
    downloadTickets.delete(req.params.ticket);
  } catch (error) {
    if (error.name === "AbortError") {
      return res.status(504).json({ error: "Media request timed out." });
    }
    if (!res.headersSent) {
      return res.status(502).json({ error: "Could not retrieve media." });
    }
    res.end();
  }
}

app.get("/api/download/:ticket", downloadLimiter, (req, res) =>
  streamTicket(req, res, "download")
);

app.get("/api/thumbnail/:ticket", downloadLimiter, (req, res) =>
  streamTicket(req, res, "thumbnail")
);

app.use(express.static(path.join(__dirname, "public")));

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error." });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});