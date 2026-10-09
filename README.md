# Aaron-Member-Map

A map of where the members of a Discord server are from.

- Members **log in with Discord**. The site checks that they are in the server (and, optionally,
  that they have a certain role) before they can add themselves.
- They pick their **country and province** (e.g. Norway → Rogaland) from the list or by clicking
  the province on the map.
- Everyone sees the map with each member's **profile picture** in their province. Clicking a
  picture shows who it is and where they're from. Pictures close together are grouped; click a
  group to zoom in.
- A **Discord message** with a picture of the map (one dot per member) is posted to a channel and
  updated automatically whenever someone joins or moves.

## Setup

Requires Node.js 20.12 or newer.

```sh
npm install
cp .env.example .env   # then fill it in, see below
npm start              # http://localhost:3000
```

### 1. Discord application (login)

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. **OAuth2** → copy the **Client ID** and **Client Secret** into `DISCORD_CLIENT_ID` and
   `DISCORD_CLIENT_SECRET`.
3. **OAuth2 → Redirects** → add `<PUBLIC_URL>/auth/callback`
   (e.g. `http://localhost:3000/auth/callback`, and your real domain when deployed).
4. In Discord, enable **Developer Mode** (User Settings → Advanced), right-click your server →
   **Copy Server ID** → `DISCORD_GUILD_ID`.
5. Set `SESSION_SECRET` to a long random string (`openssl rand -hex 32`).

Login asks only for the `identify` and `guilds.members.read` scopes: the site can see who you are
and whether you're in *this* server, not which other servers you're in. The token is revoked
right after the check.

### 2. The Discord map message (optional)

In the channel where the map should appear: **Edit Channel → Integrations → Webhooks → New
Webhook** → **Copy Webhook URL** → `DISCORD_WEBHOOK_URL`.

On start-up the site posts the map picture there, then edits that same message (about 15 seconds
after the last change) whenever someone adds, moves or removes themselves. If the message is
deleted, a new one is posted. The current picture is also available at `/map.png`.

### 3. Cleaning up people who leave (optional)

Without a bot, a member's pin stays until they remove it. To remove pins of people who have left
the server (or lost `DISCORD_REQUIRED_ROLE_ID`), and keep names and pictures up to date:

1. In the developer portal, **Bot** → **Reset Token** → `DISCORD_BOT_TOKEN`.
2. **OAuth2 → URL Generator** → scope `bot`, no permissions → open the URL and add the bot to
   your server.

The site then checks every pinned member once an hour.

### Other settings

| Variable | Default | |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:PORT` | Address of the site. Use `https://` in production (cookies are then marked secure). |
| `PORT` | `3000` | |
| `SITE_TITLE` | `Member Map` | Shown on the page and in the Discord message. |
| `MAP_PUBLIC` | `true` | `false` = only logged-in members can see the map. |
| `DISCORD_REQUIRED_ROLE_ID` | – | Only members with this role can add themselves. |
| `DATA_DIR` | `data` | Where pins are saved (`store.json`). |
| `TILE_URL`, `TILE_ATTRIBUTION` | CARTO light | Background map tiles. |

## Deploying

Any host that runs a long-lived Node.js process works (a VPS, Railway, Render, Fly.io, …):

- run `npm ci --omit=dev && npm start`,
- set the environment variables (or a `.env` file),
- make sure `DATA_DIR` is on **persistent storage**, otherwise pins are lost on redeploy,
- serve it over HTTPS and add the `https://…/auth/callback` redirect in the developer portal.

## How it works

```
server/
  index.js     Express app: Discord login, API, /map.png, Discord message updates
  discord.js   Discord OAuth2, membership checks and the webhook message
  render.js    Draws the map picture (SVG with d3-geo → PNG with resvg)
  store.js     Pins, saved to DATA_DIR/store.json
  geodata.js   Country/province lookup for validation and drawing
public/
  index.html, app.js, style.css   The map page (Leaflet + Leaflet.markercluster)
  data/                           Country and province shapes
scripts/build-geodata.mjs         Regenerates public/data
```

A member's picture is placed at their province's label point, so the map shows provinces,
never exact locations. Only the Discord ID, username, display name, avatar and chosen province
are stored.

### Map data

Country and province borders come from [Natural Earth](https://www.naturalearthdata.com/)
(public domain), simplified and split per country into `public/data`. To regenerate them
(e.g. at a different level of detail, by changing the `-simplify` percentages):

```sh
npm run build:geodata
```

Natural Earth's provinces don't always follow the latest reforms (for example, Norway is split
into its pre-2020 counties, so Rogaland is there but Vestland is Hordaland and Sogn og Fjordane).
