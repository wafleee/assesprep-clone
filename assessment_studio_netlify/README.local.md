# Assessment Studio — Gemini

This version uses one server-side Gemini configuration for every user.
Students do not enter or receive the Gemini API key.

## First-time local setup (Windows)

1. Open this folder in File Explorer.
2. Click the address bar, type `cmd`, and press Enter.
3. Set an admin password for the first startup:

   `set ADMIN_PASSWORD=your-strong-admin-password`

   Keep that CMD window open. The server stores a salted password hash in `data/config.json` on first startup.

4. Start the server:

   `npm start`

5. Open `http://127.0.0.1:8000`.
6. Click Admin and log in with the password from step 3.
7. Enter the Gemini API key and click Save globally.

The API key is stored server-side in `data/config.json` and is never returned by the admin API. The browser only receives `hasKey: true/false`.

After saving, reloading the page does not require entering the API key again. The Admin panel shows that a key is already saved; leave the key field blank to keep it.

## Persistent admin login

The browser stores only a short-lived admin session token. Reloading the page keeps the session while the server is running and for up to 12 hours. Restarting the server invalidates old sessions.

## Production

For public hosting, set `ADMIN_PASSWORD` and preferably `GEMINI_API_KEY` as secure environment variables in the hosting provider. Do not commit `data/config.json` or a real `.env` file to GitHub. Make sure your host provides persistent storage if you want Admin-panel changes to survive redeploys.
