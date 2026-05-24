# Sunday API

The Sunday backend, deployed as a **Cloudflare Worker**. Proxies the browser app's chat requests to the Anthropic API using a server-side key, so worship leaders never have to paste one of their own.

Front-end repo: [RM-Selah/sunday](https://github.com/RM-Selah/sunday) (served from `https://rm-selah.github.io/sunday/`).

## Endpoints

| Method | Path     | What it does |
|--------|----------|--------------|
| `GET`  | `/`      | Friendly landing page |
| `GET`  | `/health`| JSON status + model + whether the API key is set |
| `POST` | `/chat`  | Anthropic `/v1/messages` proxy. Same payload shape as Anthropic's API; the Worker injects the key. |

## Deploy

One-time setup:

```bash
npm install                                # installs wrangler locally
npx wrangler login                         # browser flow, links to your Cloudflare account
npx wrangler secret put ANTHROPIC_API_KEY  # paste your sk-ant-... key when prompted
npx wrangler deploy                        # ships it
```

Subsequent deploys after editing `worker.js`:

```bash
npx wrangler deploy
```

Your Worker's default URL appears in the deploy output — looks like `https://sunday-api.<account-subdomain>.workers.dev`.

## Local development

```bash
npx wrangler dev
```

For local secrets, create a `.dev.vars` file (gitignored):

```
ANTHROPIC_API_KEY=sk-ant-...
```

## Custom domain (optional)

In the Cloudflare dashboard:

1. Pick your domain (e.g. `runworship.com`)
2. **Workers Routes** → add `api.runworship.com/*` → `sunday-api`
3. Update the front-end `apiUrl` to point at `https://api.runworship.com`

## Legacy

The original Node HTTP server lives in [`legacy/sunday-server.js`](legacy/) for reference. Run it locally with `npm run start:legacy`. The Worker (`worker.js`) is what's deployed.
