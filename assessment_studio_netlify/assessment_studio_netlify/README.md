# Assessment Studio — Netlify deployment

This version is prepared for Netlify Static Hosting + Netlify Functions.

## Deploy with Netlify

1. Put this folder in a GitHub repository, or use Netlify's manual deploy workflow if your plan/workflow supports function deployment from the uploaded project.
2. In Netlify, create/import the site from this repository.
3. Netlify will read `netlify.toml`, publish `public/`, and build the function in `netlify/functions/`.
4. In **Project configuration → Environment variables**, add:

   - `ADMIN_PASSWORD` — the password used to unlock the Admin panel.
   - `GEMINI_API_KEY` — your Gemini API key. Keep this secret.

   Optional:

   - `GEMINI_MODEL` — defaults to `gemini-3.8-flash`.
   - `GEMINI_API_ENDPOINT` — defaults to `https://generativelanguage.googleapis.com/v1beta`.
   - `ASSESSMENT_AI_ENABLED` — `true` or `false`; defaults to `true`.

5. Deploy the site.
6. Open the site's URL and use the **Admin** button to sign in.

## Important security behavior

- `GEMINI_API_KEY` is only read by the Netlify Function. It is never returned by `/api/config` or the Admin API.
- The Admin session token is signed and expires after 12 hours, so it does not depend on server memory.
- Global Admin settings such as the selected model and AI enabled/disabled state are stored in a site-wide Netlify Blobs store, so they survive new deploys.
- The Gemini API key itself is kept in Netlify Environment Variables. Netlify applies updated environment-variable values to functions on a new deploy, so redeploy after changing the key.
- The static publish directory is `public`, so the server-side function source and configuration files are not published as website files.

## Local testing

The original local server is included as `server.cjs` for reference/testing. Run `npm install` and then `npm run start:local` for the old local-server workflow.
