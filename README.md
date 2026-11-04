# Dusk

Adaptive dark mode for Chromium. Dusk prefers a site's native dark theme, otherwise paints a dark palette locally and asks [Jev](https://vercel.com/ai-gateway/models/typesafe-ai/jev) to refine surface roles, images, and palette choices. Decisions are cached per hostname.

## Install

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome or a compatible Chromium browser.
3. Enable **Developer mode**, select **Load unpacked**, and choose the `extension` folder.
4. Open Dusk's options and configure your own Vercel AI Gateway key or CPA evaluation gateway. Select **Save settings**, then **Test connection** to verify the connection. Jev requires an account with model access and paid credits.
5. Reload a website. Dusk works locally while Jev is unavailable. The popup shows connection readiness and this page’s request attempts separately.

Use the popup to select Auto, Always, or Off per site, report a problem, or pick an element to change its treatment. Reload the extension and open tabs after updating it.

## How it works

- Waits for app loading shells before deciding, samples the visible page including transparent app containers, and tries dark classes, theme attributes, and readable `prefers-color-scheme` rules before recoloring. Auto mode keeps watching for native theme changes and restores the site's styles when it becomes dark.
- Converts colors in OKLCH, preserves accent hues and meaningful swatches, and adjusts text contrast.
- Separates computed-style reads from color writes in bounded batches, prioritizes visible content, and defers offscreen work to idle time.
- Rethemes from original style snapshots when Jev changes the palette. Role corrections update affected subtrees; image corrections update affected images.
- Indexes pseudo-element selectors in readable stylesheets. Inaccessible stylesheets use exhaustive pseudo checks for correctness.
- Coalesces mutations, reuses unchanged color mappings, and pauses queued work in hidden tabs.
- Sends up to 64 typed questions per request, shares treatment instructions once per batch, ignores uncertain choices below 0.5 confidence, and runs at most one automatic quality check per fresh profile.

## Data and credentials

API keys are entered in the extension's options and stored in that browser profile's local extension storage. They are not included in this repository or sent to page scripts. Use a scoped, revocable key; local browser storage is not an encrypted secret vault.

Jev receives color, geometry, sanitized class-token, image-metadata, and aggregate pixel-statistic summaries. Dusk does not intentionally send page text, URLs, screenshots, or image pixels. A hostname heuristic excludes common banking, mail, health, government, and account domains, and pages with password fields are excluded. This heuristic cannot identify every private page: disable Jev when handling private content. Image analysis fetches bytes locally through the extension worker without cookies. Diagnostics identify page versus settings requests and report request attempts, not billed tokens. Debug mode retains exchanges in worker memory; generated test outputs and browser profiles are excluded from Git.

Native-theme discovery is heuristic. Cross-origin CSS, canvas contents, complex gradients, closed shadow roots, and unusual theme systems may need manual adjustments. Dusk is an unpacked extension, not a Chrome Web Store release.

## Development

Requires Node.js 22 or newer.

```sh
npm ci
npx playwright install chromium
npm test                  # engine, native detection and UI with a local Jev stand-in
npm run test:ui           # popup and settings flows in the unpacked extension
npm run test:sites        # also checks public sites; network-dependent
npm run test:perf -- https://www.apple.com/mac/
```

For live Jev verification, place your key in a file outside the repository and pass its path:

```sh
JEV=vercel VERCEL_KEY_FILE=/path/outside/repo/key npm test
VERCEL_KEY_FILE=/path/outside/repo/key npm run test:perf -- https://www.apple.com/mac/
```

Performance results include the unmodified page, a first visit, and a cached visit, with CPU/style/layout time, request bytes, question counts, and extension mode. Compare the same URL and browser version, check that the mode is `themed`, and treat single runs as measurements rather than universal speed claims.
