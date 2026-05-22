# Sunday Server

Deploy target for the Sunday worship-team-assistant backend. Hosts the Claude proxy and Twilio WhatsApp webhook used by the [Sunday PWA](https://github.com/RM-Selah/sunday).

The app (HTML, schema, manifest, icons) lives in [RM-Selah/sunday](https://github.com/RM-Selah/sunday). This repo is just the headless server so it can be deployed somewhere with a stable URL (Render, Railway, Fly, Heroku, a VPS — wherever) without dragging the front-end along.

## Run

```bash
cp .env.example .env   # then fill in keys
set -a && source .env && set +a
npm start
```

Required: `ANTHROPIC_API_KEY`. Optional: Twilio + Supabase env vars (see `.env.example`).

## Endpoints

See the [main repo README](https://github.com/RM-Selah/sunday#endpoints).

## Keeping in sync

`sunday-server.js` is mirrored from [RM-Selah/sunday](https://github.com/RM-Selah/sunday). When you change it there, copy it here and push.
