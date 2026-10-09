import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = (name, fallback) => {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
};

const required = (name) => {
  const value = env(name);
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
};

const port = Number(env('PORT', 3000));
const publicUrl = env('PUBLIC_URL', `http://localhost:${port}`).replace(/\/+$/, '');

export const config = {
  port,
  publicUrl,
  redirectUri: `${publicUrl}/auth/callback`,
  secureCookies: publicUrl.startsWith('https://'),
  sessionSecret: required('SESSION_SECRET'),
  dataDir: path.resolve(ROOT, env('DATA_DIR', 'data')),
  siteTitle: env('SITE_TITLE', 'Member Map'),
  // When false, only logged-in members of the server can see the map and the pin list.
  mapPublic: env('MAP_PUBLIC', 'true').toLowerCase() !== 'false',
  tileUrl: env('TILE_URL', 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'),
  tileAttribution: env(
    'TILE_ATTRIBUTION',
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  ),
  discord: {
    clientId: required('DISCORD_CLIENT_ID'),
    clientSecret: required('DISCORD_CLIENT_SECRET'),
    guildId: required('DISCORD_GUILD_ID'),
    // Optional: only members that have this role may add themselves.
    requiredRoleId: env('DISCORD_REQUIRED_ROLE_ID'),
    // Optional: channel webhook the map picture is posted to (and kept up to date in).
    webhookUrl: env('DISCORD_WEBHOOK_URL'),
    // Optional: bot in the server, used to remove pins of people who have left it.
    botToken: env('DISCORD_BOT_TOKEN'),
  },
};
