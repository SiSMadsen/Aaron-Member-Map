const API = 'https://discord.com/api/v10';
const CDN = 'https://cdn.discordapp.com';

export class DiscordError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(url, init = {}, attempt = 0) {
  const res = await fetch(url.startsWith('http') ? url : `${API}${url}`, init);
  if (res.status === 429 && attempt < 3) {
    const body = await res.json().catch(() => ({}));
    const wait = Number(body.retry_after ?? res.headers.get('retry-after') ?? 1);
    await new Promise((resolve) => setTimeout(resolve, Math.ceil(wait * 1000) + 100));
    return request(url, init, attempt + 1);
  }
  return res;
}

async function json(res, what) {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new DiscordError(`${what} failed: HTTP ${res.status} ${text.slice(0, 300)}`, res.status);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// OAuth2 login

export function authorizeUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    // guilds.members.read lets us look up the user's membership in one specific server
    // without seeing the list of every server they are in.
    scope: 'identify guilds.members.read',
    state,
    prompt: 'none',
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

export async function exchangeCode({ clientId, clientSecret, redirectUri, code }) {
  const res = await request('/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });
  return json(res, 'Token exchange');
}

export async function revokeToken({ clientId, clientSecret, token }) {
  await request('/oauth2/token/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, token }),
  }).catch(() => {});
}

export async function getCurrentUser(accessToken) {
  const res = await request('/users/@me', { headers: { Authorization: `Bearer ${accessToken}` } });
  return json(res, 'Fetching user');
}

/** The user's member object in the guild, or null when they are not a member. */
export async function getCurrentMember(accessToken, guildId) {
  const res = await request(`/users/@me/guilds/${guildId}/member`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return null;
  return json(res, 'Fetching server membership');
}

/** Looks a member up with a bot token. Returns null when they are not in the guild. */
export async function getMemberAsBot(botToken, guildId, userId) {
  const res = await request(`/guilds/${guildId}/members/${userId}`, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (res.status === 404) {
    const body = await res.json().catch(() => ({}));
    // 10007 = Unknown Member. Anything else (unknown guild, ...) is a configuration problem.
    if (body.code === 10007) return null;
    throw new DiscordError(`Member lookup failed: ${JSON.stringify(body)}`, 404);
  }
  return json(res, 'Member lookup');
}

/** Name, handle and avatar to show for a member, preferring their server-specific ones. */
export function profileOf(user, member, guildId) {
  let avatarUrl;
  if (member?.avatar) {
    avatarUrl = `${CDN}/guilds/${guildId}/users/${user.id}/avatars/${member.avatar}.png`;
  } else if (user.avatar) {
    avatarUrl = `${CDN}/avatars/${user.id}/${user.avatar}.png`;
  } else {
    const index = Number((BigInt(user.id) >> 22n) % 6n);
    avatarUrl = `${CDN}/embed/avatars/${index}.png`;
  }
  return {
    username: user.username,
    displayName: member?.nick || user.global_name || user.username,
    avatarUrl,
  };
}

// ---------------------------------------------------------------------------
// Webhook message with the map picture

function webhookForm(payload, png, filename) {
  const form = new FormData();
  form.append('payload_json', JSON.stringify({ ...payload, attachments: [{ id: 0, filename }] }));
  form.append('files[0]', new Blob([png], { type: 'image/png' }), filename);
  return form;
}

/**
 * Edits the webhook message `messageId` to show the new picture, or posts a new message if
 * there is none yet (or it was deleted). Returns the id of the message.
 */
export async function upsertWebhookMessage(webhookUrl, messageId, payload, png, filename) {
  const base = webhookUrl.split('?')[0];
  if (messageId) {
    const res = await request(`${base}/messages/${messageId}`, {
      method: 'PATCH',
      body: webhookForm(payload, png, filename),
    });
    if (res.ok) return messageId;
    if (res.status !== 404) await json(res, 'Editing the map message');
  }
  const res = await request(`${base}?wait=true`, {
    method: 'POST',
    body: webhookForm(payload, png, filename),
  });
  const message = await json(res, 'Posting the map message');
  return message.id;
}
