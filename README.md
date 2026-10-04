# dark

A camera that thinks like a scanner. Open it, shoot pages, get a file.
Everything happens on the device: no account, no cloud, no spinner.

**Live:** https://aaronseaman.github.io/dark/

Built as a PWA tuned for iPhone 17 Pro Max (440×956 pt, Dynamic Island safe areas,
home-screen standalone mode), and works in any modern browser.

## Install on iPhone

1. Open the link above in Safari.
2. Share → **Add to Home Screen**.
3. Launch **dark** from the home screen and allow the camera.
   The first launch downloads the offline text engine once (~6 MB); after that
   it works in airplane mode.

## What it does

- **Capture**: live page detection (Canny + contour hull + quad fit in a Web Worker).
  The feed dims to 45% except the detected page, which "lights up".
  Auto-capture when the page holds still for 400 ms; hold the shutter for burst.
- **Rectify + filters on the GPU** (WebGL2): perspective warp with true-aspect
  recovery, then Original / Enhance (illumination flattening) / B&W (Sauvola) /
  Gray / Ink.
- **Review**: filmstrip, rotate, crop with a 3× loupe, shadow toggle, delete,
  blank-page detection. Every destructive action has an undo.
- **OCR on device**: Tesseract (LSTM, `tessdata_fast`) in a worker, one page at a time.
  Search covers the text of every page, not just file names.
- **Export**: PDF (JPEG/1-bit passthrough, invisible text layer, optional AES-128
  password), DOCX, TXT, images. Saves through the iOS share sheet ("Save to Files").
- **Storage**: page images in the Origin Private File System, metadata in IndexedDB,
  autosaved the moment a page is captured. Unfinished scans resume from the library.

## Development

Plain ES modules, no build step. Serve the folder over HTTP(S):

```sh
python3 -m http.server 8080
```

After changing any file, re-stamp the service-worker precache list and version:

```sh
node tools/stamp.mjs
```

Tests:

```sh
node tests/detect.test.mjs   # page detector on synthetic scenes (needs ImageMagick)
node tests/pdf.test.mjs /tmp # writes sample PDF/DOCX for external validation
node tests/e2e.mjs           # full flow in headless Chromium with a fake camera (CAM=cam.y4m)
```

`main` is mirrored to `gh-pages` by `.github/workflows/pages.yml`, which GitHub Pages serves.

Third-party: [Tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0),
IBM Plex (OFL-1.1). Everything else is in this repo.

Privacy: everything stays on this device. There is no server.
