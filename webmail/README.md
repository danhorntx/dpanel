# Duperhuman

Duperhuman is a local-first, keyboard-driven email client inspired by Superhuman. It connects to Gmail through Google OAuth, supports multiple accounts, keeps a fast IndexedDB cache in the browser, and uses a small local Fastify server for Gmail API and IMAP/SMTP work.

This is a personal productivity app, not a hosted SaaS product. Run it locally unless you add authentication, deployment hardening, and your own Google OAuth verification.

## Current Feature Set

- Gmail OAuth sign-in with persisted accounts and refresh tokens.
- Multiple Gmail accounts with account switching from the sidebar and command palette.
- IMAP/SMTP fallback for providers that support app passwords.
- Local-first mailbox cache with background preload and incremental sync.
- Split inbox views: All, Important, Other, Calendar, and News.
- Fast keyboard workflow with `J`/`K`, `Shift+J`/`Shift+K`, `Space`, command palette, and Gmail-style `G` navigation.
- Full compose, reply, reply-all, forward, local draft autosave, and editable Gmail Drafts.
- Gmail draft send/delete integration so Drafts behave like real Drafts.
- Archive, delete, restore/move-to-inbox, spam, star, read/unread, mute, snooze, and undo flows.
- HTML email sandboxing in an iframe with remote image blocking, per-sender preview theme, and external link opening.
- Settings for remote image loading and default light/dark email preview pane.
- Local labels and rules. Gmail provider labels are intentionally not rendered as Duperhuman labels unless the user creates a local label in the app.
- Snippets in compose with `;` expansion.
- Local search over cached mail with command palette and search page support.
- Attachment preview/download plumbing for fetched attachment metadata.

## Architecture

```text
superhuman-clone/
  client/
    src/
      components/    React UI: layout, list, thread, compose, labels, snippets
      db/            Dexie IndexedDB schema and migrations
      hooks/         Global keyboard and virtual list hooks
      lib/           API client, outbox, mutations, search, rules, contacts
      store/         Zustand stores for email, UI, labels, snippets
      types/         Shared TypeScript types
  server/
    src/
      routes/        Fastify routes for auth, accounts, emails, search, sync
      services/      Gmail API, IMAP, SMTP, account cache, background sync
```

The client paints from IndexedDB first, then syncs in the background. Mutations update the UI optimistically, write to local storage, and then flush to the server. Failed mail mutations are queued for retry.

## Stack

| Layer | Technology |
| --- | --- |
| Client | Vite, React, TypeScript |
| State | Zustand |
| Local database | Dexie / IndexedDB |
| Search | MiniSearch |
| Motion | Framer Motion |
| Icons | Phosphor Icons |
| Server | Fastify, Node.js |
| Gmail | Google OAuth + Gmail API |
| IMAP | node-imap + mailparser |
| SMTP | nodemailer |

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create `.env`

```bash
cp .env.example .env
```

Generate a session secret:

```bash
openssl rand -hex 32
```

Put that value in `.env`:

```env
SESSION_SECRET=your_64_character_hex_secret
```

### 3. Configure Gmail OAuth

In Google Cloud Console:

1. Create or select a project.
2. Enable the Gmail API.
3. Configure the OAuth consent screen.
4. While in development, add each Gmail account as a test user.
5. Create an OAuth client with application type `Web application`.
6. Add this exact authorized redirect URI:

```text
http://127.0.0.1:3001/api/auth/google/callback
```

Add the OAuth values to `.env`:

```env
GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_REDIRECT_URI=http://127.0.0.1:3001/api/auth/google/callback
```

The app uses Gmail read/modify/send scopes so it can load mail, archive/delete/restore messages, manage Drafts, and send mail. If the OAuth app is still in testing, only listed test users can sign in. If Google says the app has not passed verification, add the account as a test user or complete Google's verification process.

### 4. Optional IMAP seed account

OAuth is preferred for Gmail. For IMAP/SMTP providers, you can pre-seed one account:

```env
ENABLE_DEFAULT_IMAP_ACCOUNT=true
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_TLS=true
IMAP_USER=you@gmail.com
IMAP_PASS=your_app_password

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=you@gmail.com
SMTP_PASS=your_app_password
SMTP_FROM_NAME=Your Name
```

### 5. Run the app

Start the server:

```bash
npm run dev --workspace=server
```

Start the client in another terminal:

```bash
npm run dev --workspace=client
```

Open:

```text
http://127.0.0.1:3000/
```

## Gmail Notes

- Gmail OAuth accounts are stored by the local server in an encrypted local file.
- The Gmail API is used for list, read, send, trash, untrash, modify, and draft operations.
- Deleting a normal Gmail message moves it to Trash.
- Deleting a Gmail Draft deletes the Gmail draft object.
- Sending an edited Gmail Draft updates and sends the existing draft instead of creating a duplicate message.
- Gmail provider label IDs are not shown as app labels. Duperhuman labels are local, editable labels created inside the app.

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `J` / `K` | Move one email down/up |
| `Shift+J` / `Shift+K` | Jump through the email list |
| `Space` / `Shift+Space` | Scroll the preview pane down/up |
| `Enter` | Open selected email, or edit selected draft |
| `U` | Deselect |
| `G` `I` | Go to Inbox |
| `G` `S` | Go to Starred |
| `G` `T` | Go to Sent |
| `G` `D` | Go to Drafts |
| `G` `E` | Go to Trash |
| `1` - `5` | Switch inbox split |
| `Tab` / `Shift+Tab` | Next/previous inbox split |
| `C` | Compose |
| `R` | Reply |
| `A` | Reply all |
| `F` | Forward |
| `Cmd/Ctrl+Enter` | Send from compose |
| `E` | Archive, or move Trash/Spam/Snoozed/Archived mail back to Inbox |
| `#` | Delete |
| `S` | Star/unstar |
| `!` | Mark as spam |
| `H` | Snooze |
| `M` | Mute thread |
| `Shift+U` | Mark unread |
| `Cmd/Ctrl+Z` | Undo last archive/delete |
| `Cmd/Ctrl+K` | Command palette |
| `/` | Search |
| `L` | Label selected email |
| `?` | Shortcuts overlay |

## Labels And Rules

Duperhuman labels are local labels created in the app. They support:

- manual apply/remove with `L`;
- sidebar browsing;
- rename/delete from the label manager;
- color selection;
- rule-based auto-tagging;
- bulk rule re-run against cached mail.

Provider-native Gmail labels are deliberately ignored in the UI because Gmail label IDs do not map to editable Duperhuman label records. This prevents orphan chips that cannot be renamed or removed inside the app.

## Settings

Open `Labels & Rules` from the sidebar, then choose `Settings`.

Available settings:

- Compose in full screen.
- Reply/forward in full screen.
- Automatically load remote images in HTML emails.
- Default HTML email preview theme: Light or Dark.

Remote images are blocked by default. Each HTML email also has a one-off `Load images` action and a light/dark preview toggle.

## Local Data

Local browser data lives in IndexedDB:

- cached emails;
- accounts mirrored to the client;
- local drafts and outbox;
- labels and snippets;
- queued mail mutations;
- sync metadata.

Server-side Gmail account refresh tokens are persisted separately in an encrypted local server file and are ignored by git.

## Development Commands

```bash
# Client type check
cd client
../node_modules/.bin/tsc

# Server type check
cd server
../node_modules/.bin/tsc

# Build
npm run build
```

If your shell cannot find `npm` in the Codex desktop environment, use the bundled Node runtime path or run the commands from a normal terminal.

## Production Build

```bash
npm run build
npm run start --workspace=server
```

Serve `client/dist` with a static host and keep the API server on `127.0.0.1:3001` unless you add authentication and deployment hardening.

## Security And Limitations

- Do not expose this app publicly without adding authentication.
- Gmail OAuth apps in testing only work for configured test users.
- Google verification may be required for broader Gmail scope usage.
- Snooze and follow-up resurfacing are client/local workflows.
- Labels are local Duperhuman labels, not synced Gmail labels.
- Search covers locally cached mail.
- This project is designed for a single local user.
