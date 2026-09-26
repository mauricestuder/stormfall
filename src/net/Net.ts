import Peer, { type DataConnection } from 'peerjs';

/**
 * Online play with friends: peer-to-peer over WebRTC, matched up by a short room code through the
 * public PeerJS broker. The host is the hub: everyone else talks only to the host, who relays.
 */

/** Arena modes, plus online battle royale: `br` everyone for themselves, `brs` all friends in one squad. */
export type ArenaKind = 'ffa' | 'tdm' | 'br' | 'brs';
export type DMKind = 'ffa' | 'tdm';
export const isBR = (k: ArenaKind) => k === 'br' || k === 'brs';

export interface RosterEntry {
  id: number;
  name: string;
  team: number;
  /** Outfit index (see SKINS). */
  skin?: number;
}

/** Battle royale: every item [packed kind, x, y, z] and chest [x, y, z] on the island, as the host has them. */
export interface LootLayout {
  i: [unknown, number, number, number][];
  c: number[][];
}

export interface BotEntry {
  id: number;
  name: string;
  team: number;
  hue: number;
}

export type Msg =
  | { t: 'hello'; name: string; skin?: number }
  | { t: 'lobby'; roster: RosterEntry[]; kind: ArenaKind; you?: number }
  | { t: 'start'; kind: ArenaKind; roster: RosterEntry[]; bots: BotEntry[]; tod: string; wx: string; seed?: number; loot?: LootLayout }
  /** A player's own state (position, velocity, look, alive, weapon, crouch, movement mode). */
  | { t: 'st'; id: number; p: number[]; v: number[]; y: number; a: 0 | 1; w: string; r: number; c: 0 | 1; md?: number; h?: number; ar?: number }
  /** Battle royale: an item appeared (dropped, spilled from a chest or a body) / was picked up. */
  | { t: 'drop'; n: number; k: unknown; p: number[] }
  | { t: 'take'; n: number }
  | { t: 'chest'; k: number }
  | { t: 'door'; i: number; o: 0 | 1; s: number }
  /** Cars being driven: [index, x, y, z, yaw, vx, vy, vz, speed, driver id] each. */
  | { t: 'veh'; s: number[][] }
  | { t: 'sup'; x: number; z: number }
  | { t: 'zone'; ph: number; st: string; tm: number }
  /** All the host's bots: [id, x, y, z, vx, vz, yaw, alive, weapon, rarity, crouch] each. */
  | { t: 'bots'; s: (number | string)[][]; left: number }
  | { t: 'shot'; id: number; w: string; m: number[]; e: number[] }
  | { t: 'dmg'; to: number; from: number; amt: number; head: 0 | 1 }
  | { t: 'kill'; victim: number; killer: number; w: string; head: 0 | 1; how?: string; rd?: 1 }
  | { t: 'nade'; id: number; k: string; p: number[]; v: number[] }
  | { t: 'end' }
  | { t: 'bye'; id: number };

/** Message types the host passes on to everyone else. */
const RELAY = new Set(['st', 'shot', 'kill', 'nade', 'drop', 'take', 'chest', 'door', 'veh']);

const PREFIX = 'stormfall-arena-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

export class Net {
  peer: Peer;
  isHost: boolean;
  code: string;
  myId = 1;
  kind: ArenaKind = 'tdm';
  roster: RosterEntry[] = [];
  /** Connections: for the host one per guest (keyed by their id); for a guest just the host (id 1). */
  private conns = new Map<number, DataConnection>();
  private nextId = 2;
  onMsg: (m: Msg, from: number) => void = () => {};
  onLobby: () => void = () => {};
  onClose: (why: string) => void = () => {};
  closed = false;

  private constructor(peer: Peer, isHost: boolean, code: string) {
    this.peer = peer;
    this.isHost = isHost;
    this.code = code;
    addEventListener('beforeunload', () => this.close());
  }

  /** Opens a room. Retries a few times if the code is still held (e.g. right after a reload). */
  static async host(name: string, kind: ArenaKind, code = randomCode(), skin = 0): Promise<Net> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const peer = await openPeer(PREFIX + code);
        const net = new Net(peer, true, code);
        net.kind = kind;
        net.roster = [{ id: 1, name, team: 0, skin }];
        peer.on('connection', (c) => net.accept(c));
        peer.on('disconnected', () => peer.reconnect());
        return net;
      } catch (e) {
        lastErr = e;
        if (String((e as { type?: string }).type) !== 'unavailable-id') break;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    throw lastErr;
  }

  /** Joins a friend's room by its code. */
  static async join(code: string, name: string, skin = 0): Promise<Net> {
    const peer = await openPeer();
    const net = new Net(peer, false, code.toUpperCase());
    const conn = peer.connect(PREFIX + net.code, { reliable: true });
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => rej(new Error('No room with that code (or it is full).')), 9000);
      peer.on('error', (e) => {
        clearTimeout(timer);
        rej(e.type === 'peer-unavailable' ? new Error('No room with that code.') : e);
      });
      conn.on('open', () => {
        clearTimeout(timer);
        res();
      });
    });
    net.conns.set(1, conn);
    conn.on('data', (d) => net.receive(d as Msg, 1));
    conn.on('close', () => net.lost('The host left the game.'));
    conn.send({ t: 'hello', name, skin } satisfies Msg);
    return net;
  }

  private accept(c: DataConnection) {
    c.on('open', () => {
      if (this.roster.length >= 8 || this.started) {
        c.send({ t: 'bye', id: -1 } satisfies Msg);
        setTimeout(() => c.close(), 300);
        return;
      }
      const id = this.nextId++;
      this.conns.set(id, c);
      c.on('data', (d) => this.receive(d as Msg, id));
      c.on('close', () => {
        this.conns.delete(id);
        this.roster = this.roster.filter((r) => r.id !== id);
        this.broadcast({ t: 'bye', id });
        this.onMsg({ t: 'bye', id }, id);
        this.sendLobby();
      });
    });
  }

  started = false;

  private receive(m: Msg, from: number) {
    if (this.isHost) {
      if (m.t === 'hello') {
        const team = this.kind === 'tdm' ? balanceTeam(this.roster) : 0;
        const skin = Math.max(0, Math.min(63, Math.floor(Number(m.skin) || 0)));
        this.roster.push({ id: from, name: clean(m.name) || `Player ${from}`, team, skin });
        this.sendLobby();
        return;
      }
      if (RELAY.has(m.t)) this.broadcast(m, from);
      if (m.t === 'dmg' && m.to !== 1 && this.conns.has(m.to)) {
        // Damage for another guest goes straight to them; damage for bots or the host is ours.
        this.conns.get(m.to)!.send(m);
        return;
      }
    } else {
      if (m.t === 'lobby') {
        this.roster = m.roster;
        this.kind = m.kind;
        if (m.you) this.myId = m.you;
        this.onLobby();
        return;
      }
      if (m.t === 'bye' && m.id === -1) {
        this.lost('That game is full or already started.');
        return;
      }
    }
    this.onMsg(m, from);
  }

  /** Host: tell everyone who's in the room (each guest learns their own id too). */
  sendLobby() {
    if (!this.isHost) return;
    for (const [id, c] of this.conns) if (c.open) c.send({ t: 'lobby', roster: this.roster, kind: this.kind, you: id } satisfies Msg);
    this.onLobby();
  }

  setKind(kind: ArenaKind) {
    this.kind = kind;
    // Re-deal the teams when switching to team deathmatch.
    this.roster.forEach((r, i) => (r.team = kind === 'tdm' ? i % 2 : 0));
    this.sendLobby();
  }

  switchTeam(id: number) {
    const r = this.roster.find((e) => e.id === id);
    if (!r || this.kind !== 'tdm') return;
    r.team = 1 - r.team;
    this.sendLobby();
  }

  /** Guest: to the host. Host: to every guest (except `except`). */
  send(m: Msg) {
    if (this.isHost) this.broadcast(m);
    else {
      const c = this.conns.get(1);
      if (c?.open) c.send(m);
    }
  }

  private broadcast(m: Msg, except = -1) {
    for (const [id, c] of this.conns) if (id !== except && c.open) c.send(m);
  }

  /** Damage for someone owned elsewhere: the host routes it to whoever owns them. */
  sendDamage(m: Extract<Msg, { t: 'dmg' }>) {
    if (this.isHost) this.conns.get(m.to)?.send(m);
    else this.send(m);
  }

  get guests() {
    return this.conns.size;
  }

  private lost(why: string) {
    if (this.closed) return;
    this.closed = true;
    this.onClose(why);
  }

  close() {
    if (this.closed && this.peer.destroyed) return;
    this.closed = true;
    for (const c of this.conns.values()) c.close();
    this.peer.destroy();
  }
}

function openPeer(id?: string): Promise<Peer> {
  return new Promise((res, rej) => {
    const peer = id ? new Peer(id, { debug: 0 }) : new Peer({ debug: 0 });
    const timer = setTimeout(() => {
      peer.destroy();
      rej(new Error('Could not reach the matchmaking server. Check your internet connection.'));
    }, 10000);
    peer.on('open', () => {
      clearTimeout(timer);
      res(peer);
    });
    peer.on('error', (e) => {
      clearTimeout(timer);
      peer.destroy();
      rej(e);
    });
  });
}

function balanceTeam(roster: RosterEntry[]) {
  const a = roster.filter((r) => r.team === 0).length, b = roster.length - a;
  return a <= b ? 0 : 1;
}

function clean(name: string) {
  return String(name ?? '').replace(/[<>&"]/g, '').trim().slice(0, 16);
}
