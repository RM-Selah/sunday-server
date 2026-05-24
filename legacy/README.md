# Legacy — Node HTTP server

The Sunday backend is now a Cloudflare Worker (`../worker.js`). This file is the original Node `http` server, kept for reference and for anyone who wants to run the API locally without Cloudflare.

To run it:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node legacy/sunday-server.js
```

It includes a few endpoints the Worker doesn't have yet (WhatsApp via Twilio, sync-state for browser team-state broadcast). If you need those, port them into `worker.js` rather than running this in production.
