> **Video-to-GIF server deployment:** See `DEPLOY_NETLIFY_RENDER_SK.md`, `render.yaml`. GIF width/FPS/duration are now configurable in the frontend.

# Forma — Quality-first media converter

A responsive, no-build web application plus a self-hosted conversion engine for images and videos.

## What works

**Without a backend (Netlify static deploy):** Upload, automatic format detection from file signatures for common types, local JPEG/PNG/WebP conversion, basic image previews, batch workflow, quality presets, comparison slider, downloads, theme, history, drag-and-drop and keyboard shortcuts. Browser conversion is **not** guaranteed to preserve EXIF, ICC or true losslessness. It never claims otherwise. Browser-only videos can be downloaded unchanged but **cannot be transcoded**.

**With the backend:** image conversion using Pillow (+ optional Pillow HEIF and RAW), actual FFmpeg video conversion, metadata inspection using FFprobe, automatic stream-copy when compatible, progress polling, true-lossless FFV1 in MKV, source/original dimensions preserved, ZIP for server-converted files, preview generation for non-browser-supported image types, streaming uploads (up to configured limit), configurable CORS and cleanup. Supported image *output* types depend on the Pillow build and installed codecs and are reported via `/api/capabilities`.

**Known limits:** arbitrary formats are not possible; multi-frame image preservation is not guaranteed (the image worker refuses unsupported animation paths); HDR and some unusual color profiles cannot be guaranteed for video transcoding (the current H.264/VP9 presets output SDR-compatible 8-bit video; H.265 uses 10-bit but may still lose HDR signalling). The RAW decoder currently needs further 16-bit RGB output work and should be tested against your camera files. The local-mode browser canvas may strip metadata, change color precision and flatten transparency for JPEG. JPEG→PNG doesn't restore information already lost in JPEG. The conversion API runs in one Python process and its job list is in memory; restarting the backend discards job statuses. No authentication and no persistent queue; use behind trusted access or add authentication before exposing publicly.

## One-minute Netlify deployment (frontend)

1. Open [Netlify](https://app.netlify.com/drop).
2. Drag the **`site` folder** into the deploy area. This creates a public frontend URL. No build steps.
3. Try a browser-only JPEG/PNG/WebP conversion. For HEIC/RAW/videos, connect the backend in **Settings**.

Git deployment also works: connect this repository; `netlify.toml` sets publish directory to `site`.

## Backend with Docker

On a machine that can run Docker, from the repository root:

```sh
# Update CORS_ORIGINS in docker-compose.yml to match your real Netlify URL.
docker compose up --build -d
```

The backend is now reachable at `http://localhost:8000`. API docs: `http://localhost:8000/docs`.

For a public **HTTPS** site, the backend **must have a public HTTPS address** (e.g. a container host with a reverse proxy and TLS). A Netlify HTTPS page cannot call `http://localhost:8000` on another user's computer. Example providers for Docker containers: Render, Railway, Fly.io or your own VPS. The app does not deploy a container from Netlify static hosting.

Set your HTTPS API URL in the app's **Settings**. The backend allows only origins listed under `CORS_ORIGINS`; use the exact frontend URL, without a trailing slash.

### Backend environment variables

| Key | Default | Usage |
|---|---|---|
| `DATA_DIR` | `/tmp/forma-jobs` | temporary job files |
| `MAX_UPLOAD_MB` | `2048` | total upload limit per file |
| `JOB_TTL_SECONDS` | `3600` | completed job retention |
| `MAX_CONCURRENT_JOBS` | `2` | concurrent transcoders |
| `CORS_ORIGINS` | localhost origins | comma-separated trusted website origins |

Check host disk, network and bandwidth quotas. This prototype is suitable for personal use, not an unprotected public production SaaS service. Add server-side authentication, rate limiting, quotas, durable work queue, process sandboxing and audit logging before opening conversion APIs to the internet.

## Run locally without Docker

```sh
cd backend
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
# FFmpeg and FFprobe must be on PATH.
uvicorn main:app --host 127.0.0.1 --port 8000
```

Host the static files in a second terminal:

```sh
python -m http.server 8888 --directory site
```

Visit http://localhost:8888 and set API URL to http://localhost:8000 under Settings.

## QA smoke tests

A script in `tests/smoke_test.py` exercises the actual backend with generated image and video test files. Run `python tests/smoke_test.py` once dependencies and FFmpeg are available.

## Architecture

`site/index.html` — accessible semantic HTML; `site/styles.css` — hand-authored responsive design; `site/app.js` — client-side controller and local converter; `backend/main.py` — FastAPI job API with Pillow and FFmpeg; `backend/Dockerfile` and `docker-compose.yml` — backend container; `netlify.toml` — static deployment.

**Netlify practical limits (Oct 2026):** normal functions: ~60s execution, 6 MB buffered payload. Background functions: up to 15 min, 256 KB invocation payload. Large video upload, conversion and delivery should use an external worker, not try to squeeze the video payload through Netlify Functions.

## Third-party licenses

FFmpeg, video codec encoders, Pillow and image codec libraries have their own licenses; review them, as well as patent/codec requirements, before commercial distribution. Google Fonts are fetched via CSS at runtime and have local system-font fallbacks.

## Update: Render deployment and per-user access key

`render.yaml` provides a Render Blueprint for the FFmpeg API. The `API_ACCESS_KEY` environment variable is a strong user-chosen token. When configured, the upload, conversion, archive and delete APIs require `X-Forma-Key`, supplied by the site's **Server access key** setting. This is useful for a private personal converter, but not a complete public multi-user security architecture. Browsers store the key in their own localStorage. Random job IDs protect download URLs from guessing, but anyone with an output URL can access that output before cleanup.

The sample Render Blueprint defaults to **free for testing only**. For 4K/large source videos, use a more capable computer or a hosting plan with at least 2 GB RAM. This project has not been tested on Render itself; local API tests validate functionality, not hosting quotas or deployment behavior.
