import { randomBytes } from 'node:crypto';
import path from 'node:path';
import cookieSession from 'cookie-session';
import express from 'express';
import { config, ROOT } from './config.js';
import * as discord from './discord.js';
import { findProvince, getCountry } from './geodata.js';
import { renderMapPng } from './render.js';
import { Store } from './store.js';

const store = await new Store(config.dataDir).load();
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  cookieSession({
    name: 'session',
    keys: [config.sessionSecret],
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
  }),
);
app.use(express.json({ limit: '10kb' }));

const currentUser = (req) => req.session?.user ?? null;

function requireMember(req, res, next) {
  if (!currentUser(req)) return res.status(401).json({ error: 'Log in with Discord first.' });
  next();
}

// Pins are changed with fetch() + JSON. Browsers won't send a cross-site JSON request without
// a CORS preflight (which we never allow), so this blocks cross-site request forgery.
function requireJson(req, res, next) {
  if (!req.is('application/json')) return res.status(415).json({ error: 'Expected JSON.' });
  next();
}

function publicPin(m) {
  return {
    id: m.id,
    displayName: m.displayName,
    username: m.username,
    avatarUrl: m.avatarUrl,
    countryCode: m.countryCode,
    countryName: m.countryName,
    provinceId: m.provinceId,
    provinceName: m.provinceName,
    lat: m.lat,
    lon: m.lon,
  };
}

// ---------------------------------------------------------------------------
// Discord login

app.get('/auth/login', (req, res) => {
  const state = randomBytes(16).toString('hex');
  req.session.oauthState = state;
  res.redirect(
    discord.authorizeUrl({ clientId: config.discord.clientId, redirectUri: config.redirectUri, state }),
  );
});

app.get(
  '/auth/callback',
  async (req, res) => {
    const { code, state, error } = req.query;
    const expected = req.session.oauthState;
    delete req.session.oauthState;
    if (error) return res.redirect('/?error=cancelled');
    if (!code || !state || state !== expected) return res.redirect('/?error=state');

    const token = await discord.exchangeCode({
      clientId: config.discord.clientId,
      clientSecret: config.discord.clientSecret,
      redirectUri: config.redirectUri,
      code: String(code),
    });
    try {
      const user = await discord.getCurrentUser(token.access_token);
      const member = await discord.getCurrentMember(token.access_token, config.discord.guildId);
      req.session.user = null;
      if (!member) return res.redirect('/?error=not_member');
      if (config.discord.requiredRoleId && !member.roles?.includes(config.discord.requiredRoleId)) {
        return res.redirect('/?error=missing_role');
      }
      const profile = discord.profileOf(user, member, config.discord.guildId);
      req.session.user = { id: user.id, ...profile };
      await store.updateProfile(user.id, profile);
      res.redirect('/');
    } finally {
      // We only needed the token to check membership once.
      discord.revokeToken({
        clientId: config.discord.clientId,
        clientSecret: config.discord.clientSecret,
        token: token.access_token,
      });
    }
  },
);

app.post('/auth/logout', requireJson, (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// API

app.get('/api/config', (req, res) => {
  res.json({
    title: config.siteTitle,
    mapPublic: config.mapPublic,
    tileUrl: config.tileUrl,
    tileAttribution: config.tileAttribution,
  });
});

app.get('/api/me', (req, res) => {
  const user = currentUser(req);
  const pin = user ? store.getMember(user.id) : null;
  res.json({ user, pin: pin ? publicPin(pin) : null });
});

app.get('/api/pins', (req, res) => {
  if (!config.mapPublic && !currentUser(req)) {
    return res.status(401).json({ error: 'Log in with Discord to see the map.' });
  }
  res.json({ pins: store.members().map(publicPin) });
});

app.put(
  '/api/pin',
  requireMember,
  requireJson,
  async (req, res) => {
    const { countryCode, provinceId } = req.body ?? {};
    const country = typeof countryCode === 'string' ? getCountry(countryCode) : null;
    if (!country) return res.status(400).json({ error: 'Unknown country.' });
    const province = typeof provinceId === 'string' ? await findProvince(country.code, provinceId) : null;
    if (!province) return res.status(400).json({ error: 'Unknown province.' });

    const user = currentUser(req);
    const previous = store.getMember(user.id);
    await store.setMember({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      countryCode: country.code,
      countryName: country.name,
      provinceId: province.properties.id,
      provinceName: province.properties.name,
      lat: province.properties.lat,
      lon: province.properties.lon,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
    });
    res.json({ pin: publicPin(store.getMember(user.id)) });
  },
);

app.delete(
  '/api/pin',
  requireMember,
  requireJson,
  async (req, res) => {
    await store.removeMember(currentUser(req).id);
    res.json({ ok: true });
  },
);

// The same picture that is posted to Discord.
let pngCache = null;
store.onPinsChanged(() => {
  pngCache = null;
});
const currentPng = () => (pngCache ??= renderMapPng(store.members()));

app.get(
  '/map.png',
  async (req, res) => {
    if (!config.mapPublic && !currentUser(req)) return res.status(401).end();
    const png = await currentPng();
    res.set('Cache-Control', 'no-cache').type('png').send(png);
  },
);

// ---------------------------------------------------------------------------
// Static files

app.use('/vendor/leaflet', express.static(path.join(ROOT, 'node_modules', 'leaflet', 'dist')));
app.use(
  '/vendor/markercluster',
  express.static(path.join(ROOT, 'node_modules', 'leaflet.markercluster', 'dist')),
);
app.use('/data', express.static(path.join(ROOT, 'public', 'data'), { maxAge: '1d' }));
app.use(express.static(path.join(ROOT, 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/auth/')) return res.redirect('/?error=discord');
  res.status(500).json({ error: 'Something went wrong.' });
});

// ---------------------------------------------------------------------------
// Discord message with the map picture

let discordTimer = null;
let discordUpdating = Promise.resolve();

function countLine(members) {
  const countries = new Set(members.map((m) => m.countryCode)).size;
  const people = members.length === 1 ? '1 member' : `${members.length} members`;
  return `${people} from ${countries === 1 ? '1 country' : `${countries} countries`}`;
}

async function postMapToDiscord() {
  const members = store.members();
  const png = await currentPng();
  const payload = {
    embeds: [
      {
        title: config.siteTitle,
        url: config.publicUrl,
        description: members.length
          ? `${countLine(members)}. Each dot is a member.\nAdd yourself at ${config.publicUrl}`
          : `Nobody is on the map yet. Add yourself at ${config.publicUrl}`,
        image: { url: 'attachment://member-map.png' },
        color: 0x5865f2,
        timestamp: new Date().toISOString(),
      },
    ],
    allowed_mentions: { parse: [] },
  };
  const id = await discord.upsertWebhookMessage(
    config.discord.webhookUrl,
    store.discordMessageId,
    payload,
    png,
    'member-map.png',
  );
  if (id !== store.discordMessageId) await store.setDiscordMessageId(id);
}

function scheduleDiscordUpdate(delay = 15_000) {
  if (!config.discord.webhookUrl) return;
  clearTimeout(discordTimer);
  // Wait for changes to settle so a burst of edits becomes one message update.
  discordTimer = setTimeout(() => {
    discordUpdating = discordUpdating
      .then(postMapToDiscord)
      .catch((err) => console.error('Updating the Discord map message failed:', err.message));
  }, delay);
}

store.onPinsChanged(() => scheduleDiscordUpdate());

// ---------------------------------------------------------------------------
// Remove pins of people who have left the server (needs a bot token)

async function pruneDepartedMembers() {
  for (const m of store.members()) {
    try {
      const member = await discord.getMemberAsBot(config.discord.botToken, config.discord.guildId, m.id);
      if (!member) {
        console.log(`Removing ${m.username} (${m.id}): no longer in the server`);
        await store.removeMember(m.id);
      } else if (config.discord.requiredRoleId && !member.roles?.includes(config.discord.requiredRoleId)) {
        console.log(`Removing ${m.username} (${m.id}): no longer has the required role`);
        await store.removeMember(m.id);
      } else {
        await store.updateProfile(m.id, discord.profileOf(member.user, member, config.discord.guildId));
      }
    } catch (err) {
      console.error(`Checking member ${m.id} failed:`, err.message);
      return;
    }
  }
}

// ---------------------------------------------------------------------------

app.listen(config.port, () => {
  console.log(`${config.siteTitle} running at ${config.publicUrl} (port ${config.port})`);
  if (config.discord.webhookUrl) scheduleDiscordUpdate(2_000);
  if (config.discord.botToken) {
    const run = () => pruneDepartedMembers().catch((err) => console.error('Pruning failed:', err));
    setTimeout(run, 10_000);
    setInterval(run, 60 * 60 * 1000);
  }
});
