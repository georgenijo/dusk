# Dusk

Adaptive dark mode for Chromium. Dusk prefers a site's native dark theme, otherwise paints a dark palette locally and asks [Jev](https://vercel.com/ai-gateway/models/typesafe-ai/jev) to refine surface roles, images, and palette choices. Decisions are cached per hostname.

## Install

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome or a compatible Chromium browser.
3. Enable **Developer mode**, select **Load unpacked**, and choose the `extension` folder.
4. Open Dusk's options and configure your own Vercel AI Gateway key or CPA evaluation gateway. Use **Test Jev** to check the connection. Jev requires an account with model access and paid credits.
5. Reload a website. Dusk works locally while Jev is unavailable; the popup shows the provider error.

Use the popup to select Auto, Always, or Off per site, report a problem, or pick an element to change its treatment. Reload the extension and open tabs after updating it.

## How it works

- Detects an already-dark page and tries dark classes, theme attributes, and readable `prefers-color-scheme` rules before recoloring.
- Converts colors in OKLCH, preserves accent hues and meaningful swatches, and adjusts text contrast.
- Separates computed-style reads from color writes in bounded batches, prioritizes visible content, and defers offscreen work to idle time.
- Rethemes from original style snapshots when Jev changes the palette. Role corrections update affected subtrees; image corrections update affected images.
- Indexes pseudo-element selectors in readable stylesheets. Inaccessible stylesheets use exhaustive pseudo checks for correctness.
- Coalesces mutations, reuses unchanged color mappings, and pauses queued work in hidden tabs.
- Sends up to 64 typed questions per request, shares treatment instructions once per batch, ignores uncertain choices below 0.5 confidence, and runs at most one automatic quality check per fresh profile.

## Data and credentials

API keys are entered in the extension's options and stored in that browser profile's local extension storage. They are not included in this repository or sent to page scripts. Use a scoped, revocable key; local browser storage is not an encrypted secret vault.

Jev receives color, geometry, sanitized class-token, image-metadata, and aggregate pixel-statistic summaries. Dusk does not intentionally send page text, URLs, screenshots, or image pixels. A hostname heuristic excludes common banking, mail, health, government, and account domains, and pages with password fields are excluded. This heuristic cannot identify every private page: disable Jev when handling private content. Image analysis fetches bytes locally through the extension worker without cookies. Debug mode retains exchanges in worker memory; generated test outputs and browser profiles are excluded from Git.

Native-theme discovery is heuristic. Cross-origin CSS, canvas contents, complex gradients, closed shadow roots, and sites that change themes after startup may need manual adjustments. Dusk is an unpacked extension, not a Chrome Web Store release.

## Development

Requires Node.js 22 or newer.

```sh
npm ci
npx playwright install chromium
npm test                  # local fixtures with a deterministic Jev stand-in
npm run test:sites        # also checks public sites; network-dependent
npm run test:perf -- https://www.apple.com/mac/
```

For live Jev verification, place your key in a file outside the repository and pass its path:

```sh
JEV=vercel VERCEL_KEY_FILE=/path/outside/repo/key npm test
VERCEL_KEY_FILE=/path/outside/repo/key npm run test:perf -- https://www.apple.com/mac/
```

Performance results include the unmodified page, a first visit, and a cached visit, with CPU/style/layout time, request bytes, question counts, and extension mode. Compare the same URL and browser version, check that the mode is `themed`, and treat single runs as measurements rather than universal speed claims.
