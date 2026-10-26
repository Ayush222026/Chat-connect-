# ConnectChat

A WhatsApp-inspired, mobile-first, one-to-one chat web app.
**Stack:** plain HTML/CSS/JS · Supabase (Auth, PostgreSQL, Realtime) · GitHub Pages + GitHub Actions. No build step.

## Features
Email/password signup & login · unique usernames & editable profile · search users and start private chats · real-time messaging · history stored in the database · timestamps, unread counts, online status, last seen, typing indicator, read receipts (✓ sent, ✓✓ blue = read) · conversation list with latest-message preview · delete your own messages (for everyone) · delete a chat (for you only) · light/dark theme · loading, error and empty states · installable PWA.

## Files
| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app |
| `config.js` | **You edit this**: Supabase URL + public key |
| `schema.sql` | Tables, indexes, constraints, RLS policies, functions, realtime |
| `sw.js`, `manifest.webmanifest`, `icon-*.png` | PWA |
| `.github/workflows/deploy.yml` | Deploys to GitHub Pages |

## Security model (what is and isn't protected)
- **Row Level Security is on** for `profiles`, `conversations`, `messages`.
- Only participants can read a conversation or its messages. Non-participants get zero rows.
- Inserting a message requires `sender_id = auth.uid()` **and** membership in that conversation — enforced by the database, so a modified client can't spoof senders.
- Conversations can only be created through the `start_conversation` function (no direct inserts). Read receipts only through `mark_read`. Messages can't be edited at all.
- Only the sender can delete a message. "Delete chat" hides history **for you only**; the other person keeps theirs.
- The browser uses only the **public** key. Never put a secret / service-role key in `config.js` (the deploy workflow refuses to deploy if it spots one).
- **Not end-to-end encrypted.** Traffic uses HTTPS/WSS and Supabase encrypts storage, but message text is readable in the database by the project owner. Don't send secrets.
- Presence (online status) uses a shared Realtime channel, and typing events use a per-conversation channel named after the unguessable conversation ID. These carry **no message text** but are not RLS-protected. Message content itself is fully RLS-protected.
- Usernames and "about" text are visible to all logged-in users (needed for search). Emails are **not** exposed.

## Setup — every step you must do yourself
All of this works from a phone browser. Use "Desktop site" if a page looks cramped.

### 1. Create the Supabase project
1. Sign up at <https://supabase.com> → **New project**. Pick a name, a strong database password (save it), and the region nearest your users.
2. Wait about 2 minutes for it to finish provisioning.

### 2. Run the schema
1. Open the project → **SQL Editor** → **New query**.
2. Open `schema.sql`, copy **all** of it, paste it in, tap **Run**. You should see "Success. No rows returned."
3. Re-running it later is safe.

### 3. Configure Authentication
1. **Authentication → Sign In / Providers → Email**: make sure Email is enabled.
2. **For testing, turn OFF "Confirm email".** Supabase's built-in email sender allows only a few emails per hour, so confirmation emails will block you from creating two test accounts. For production, turn it back on and configure custom SMTP.
3. **Authentication → URL Configuration**: set **Site URL** to your GitHub Pages address (step 5 tells you what it is, e.g. `https://YOURNAME.github.io/connectchat/`) and add the same address under **Redirect URLs**. Do this after step 5 if you don't know it yet.
4. Realtime: leave **Project Settings → Realtime → "Allow public access"** at its default (on). Typing/online indicators use public channels.

### 4. Get your public key and edit `config.js`
1. **Project Settings → API Keys** (or **Data API**). Copy the **Project URL** (`https://xxxx.supabase.co`).
2. Copy the **publishable key** (`sb_publishable_...`). If it gives 401 errors, use the **anon** key from the "Legacy API keys" tab instead. Both are safe for browsers.
3. **Never copy the `secret` or `service_role` key.**
4. In your GitHub repo (step 5), open `config.js` → pencil icon → replace `YOUR-PROJECT-REF.supabase.co` URL and `YOUR-PUBLISHABLE-OR-ANON-KEY` → **Commit changes**.

### 5. Deploy on GitHub Pages
1. Sign in at <https://github.com> → **New repository**. Name it `connectchat`, set it **Public** (free Pages requires this), tick **Add a README**, create it.
2. Upload the files: **Add file → Upload files**, select `index.html`, `styles.css`, `app.js`, `config.js`, `sw.js`, `manifest.webmanifest`, `icon-192.png`, `icon-512.png`, `schema.sql`, `README.md`. Commit to `main`. (Uploading from a phone can't pick folders, so the files are flat on purpose.)
3. Add the workflow: **Add file → Create new file**, type the name `.github/workflows/deploy.yml` (typing `/` creates the folders), paste the contents of `deploy.yml`, commit.
4. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
5. Open the **Actions** tab. The "Deploy ConnectChat" run starts on each push to `main` (use **Run workflow** if needed). When it is green, your site is at `https://YOURNAME.github.io/connectchat/`.
6. Go back to step 3.3 and enter that URL in Supabase if you hadn't yet.
7. If the workflow fails with "Edit config.js…", you haven't replaced the placeholders yet (step 4.4).

To update the app later, edit a file in GitHub and commit. It redeploys automatically.

## Test with two separate accounts
You need two independent sessions: a normal browser tab **and** a private/incognito tab (or two different browsers, or two devices).

1. **Session 1:** open the site → **Sign up** → email `alice@example.com`, username `alice`, password ≥ 8 chars.
2. **Session 2 (private tab):** sign up as `bob` with another email (e.g. `bob@example.com`; it doesn't need to be a real inbox if Confirm email is off).
3. In Session 1 tap **✚**, type `bo`, tap **bob**. A chat opens.
4. Send "hello". In Session 2 the chat **appears with an unread badge (1)** and the message arrives without refreshing.
5. In Session 2 open the chat: Session 1's tick turns **✓✓ blue** (read).
6. Type in Session 2 without sending: Session 1 shows **typing…**.
7. Both header areas show **online**. Close Session 2: Alice sees **last seen …** within about a minute.
8. Reply from Bob, log Alice out, log back in: history is still there.
9. Tap a message you sent → **Delete for everyone**: it disappears on both sides instantly.
10. Tap 🗑 in a chat → deletes it for you only. Bob still has his copy; if he messages again, it reappears for Alice with only new messages.
11. Turn on airplane mode: the yellow offline banner appears and sending is disabled. When back online, it resyncs.
12. Profile (tap your avatar): change display name/username. Try Bob's username to see the "taken" error.
13. 🌓 toggles light/dark theme.
14. **Security check (optional):** in Supabase **Table Editor**, each of `profiles`, `conversations`, `messages` should show "RLS enabled". In **SQL Editor** run `select tablename, policyname, cmd from pg_policies where schemaname = 'public';` to review the policies.

## Install as an app (PWA)
Chrome on Android: **⋮ → Add to Home screen / Install app**. The service worker caches only the app shell (screens, scripts, styles) so it opens quickly. **Sending and receiving messages requires an internet connection**; the app shows an offline banner and disables sending when disconnected. API responses and messages are never cached.

## Troubleshooting
| Symptom | Fix |
|---|---|
| "Setup needed" screen | `config.js` still has placeholders, or the Supabase script is blocked |
| "Could not load your profile" | `schema.sql` wasn't run, or ran with errors; re-run it |
| 401 / "Invalid API key" | Wrong key or URL; try the legacy `anon` key |
| Signup says check email | Disable **Confirm email** (step 3.2) |
| Messages only appear after refresh | Re-run `schema.sql` (it adds `messages` to the realtime publication); check the Realtime service isn't paused |
| Old version still shows after deploy | Close and reopen the app (service worker updates on next load), or clear site data |
| Actions run fails at "Pages" step | Settings → Pages → Source must be **GitHub Actions** |
| Free project paused | Supabase pauses inactive free projects after about 1 week; open the dashboard and restore |

## Known limitations
- Text only (no images/voice), 4000-character limit per message.
- Online status and typing are best-effort; "last seen" can lag up to about a minute.
- No push notifications when the app is closed.
- No password reset screen yet; use Supabase **Authentication → Users** to send a reset email if needed.
- Not end-to-end encrypted (see Security).
