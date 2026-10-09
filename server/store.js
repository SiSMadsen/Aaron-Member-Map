import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// A small JSON-file store. The whole state is kept in memory and written to disk
// (atomically, one write at a time) after every change.
export class Store {
  constructor(dir) {
    this.file = path.join(dir, 'store.json');
    this.dir = dir;
    this.state = { members: {}, discordMessageId: null };
    this.writing = Promise.resolve();
    this.listeners = new Set();
  }

  async load() {
    await mkdir(this.dir, { recursive: true });
    try {
      this.state = { ...this.state, ...JSON.parse(await readFile(this.file, 'utf8')) };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return this;
  }

  save() {
    const data = JSON.stringify(this.state, null, 2);
    const tmp = `${this.file}.tmp`;
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        await writeFile(tmp, data);
        await rename(tmp, this.file);
      });
    return this.writing;
  }

  /** Called with no arguments whenever the set of pins changes. */
  onPinsChanged(fn) {
    this.listeners.add(fn);
  }

  pinsChanged() {
    for (const fn of this.listeners) fn();
  }

  members() {
    return Object.values(this.state.members);
  }

  getMember(id) {
    return this.state.members[id] ?? null;
  }

  async setMember(member) {
    this.state.members[member.id] = { ...member, updatedAt: new Date().toISOString() };
    await this.save();
    this.pinsChanged();
  }

  /** Refreshes name/avatar for someone who already has a pin. */
  async updateProfile(id, profile) {
    const current = this.state.members[id];
    if (!current) return;
    if (current.displayName === profile.displayName && current.username === profile.username
        && current.avatarUrl === profile.avatarUrl) return;
    this.state.members[id] = { ...current, ...profile };
    await this.save();
    this.pinsChanged();
  }

  async removeMember(id) {
    if (!this.state.members[id]) return false;
    delete this.state.members[id];
    await this.save();
    this.pinsChanged();
    return true;
  }

  get discordMessageId() {
    return this.state.discordMessageId;
  }

  async setDiscordMessageId(id) {
    this.state.discordMessageId = id;
    await this.save();
  }
}
