# MatchFood

MatchFood connects food donors with local charities. Choose **Donor** or **Charity** on the opening page to enter the appropriate workspace.

Donors share food, manage their own donations, review collection requests, and find nearby charities. Charities browse available food, filter by location and category, and request a collection. When a donor accepts, the charity can see contact details and arrange pickup.

## Open it without installing anything

On GitHub, select **Code → Download ZIP**, extract it, and open **`MatchFood.html`** in Chrome or Edge. That file includes the complete website and its artwork. Read `START-HERE.txt` for step-by-step Windows and macOS instructions. The source-code setup below is only needed to edit or run the server version.

## Run the website

Requires Node.js 24 or newer and npm.

```sh
npm ci
npm run dev
```

The web app uses port 5173 and proxies its API to port 3001. Both processes start together. For a single server serving the built website:

```sh
npm run build
npm start
```

The server uses port 3001 by default. Optional settings are documented in `.env.example`; the Node server loads an `.env` file automatically. `ENABLE_ROLE_ACCESS=true` enables the preconfigured organisation profiles, including when running with `NODE_ENV=production`. Production session cookies require HTTPS.

No signup is required for these preconfigured profiles. They are a convenient way to use the role-based workflows, rather than a production identity provider. The included organisation data is illustrative and uses reserved contact addresses. Pickup requests stay inside the application; the server does not send emails or texts.

## Self-contained website

Generate a browser-ready version with its artwork and application code included:

```sh
npm run build:standalone
```

Open `standalone/MatchFood.html` in a browser, or run `npm run preview` to build and serve it on port 4173. The `standalone/` folder can also be served by a static website host. It needs no API server or Internet connection for the core workflows; Google Maps links require Internet when opened.

The self-contained version stores changes in the browser, separately from the server database. If browser storage is unavailable, changes last for the current page session. The cloud environment setup screen does not provide a live website preview, and running processes must be restarted after an environment restart.

## Locations and data

Organisation profiles include an address, business type, coordinates, and optional Google Maps place link. Nearby search uses saved coordinates, a selected city, or optional browser geolocation. Google Maps links open places directly and do not require Google account authentication or API keys.

The server stores profiles, listings, sessions, and requests at `.data/match-food.sqlite`, excluded from Git. Set `DATA_DIR` to choose another writable location. Existing records are preserved across restarts. An accepted collection reserves the whole donation; splitting one donation across multiple charities is outside the current workflow.

## Validate changes

```sh
npm run build
npm run build:standalone
npm test
npm run test:e2e
```

API tests use temporary databases. Browser tests cover the role-specific workflows, local standalone content, mobile layout, and keyboard navigation without changing live organisation data. Standalone browser tests load the exact generated HTML with networking disabled. This cloud Chromium blocks direct local-file navigation, so the tests supply those bytes through offline request interception rather than bypassing the managed browser policy.

Browser tests use system Chromium when available. Set `CHROMIUM_PATH` for another installation or install Playwright's browser with `npx playwright install chromium` if needed. The cloud environment already supplies Chromium.

Use the existing checkout for cloud tasks. A separate Git worktree is unnecessary unless explicitly requested.
