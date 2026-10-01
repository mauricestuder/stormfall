import { planArenaBots, TEAM_CSS, TEAM_NAMES } from '../game/Arena';
import type { Game } from '../game/Game';
import { packLoot, planBRBots } from '../game/OnlineBR';
import { isBR, Net, type ArenaKind, type DMKind, type Msg, type RosterEntry } from '../net/Net';

const NAME_KEY = 'stormfall.name';
const REJOIN_KEY = 'stormfall.rejoin';

const $ = (id: string) => document.getElementById(id)!;

/**
 * The ARENA screen: pick team deathmatch or free-for-all, then play against bots or open / join a
 * room with friends (a five-letter code), wait in the lobby and start.
 */
export class ArenaMenu {
  kind: ArenaKind = 'tdm';
  net: Net | null = null;
  private busy = false;

  constructor(private game: Game) {
    const click = (id: string, fn: () => void) => $(id).addEventListener('click', () => {
      game.sfx.unlock();
      game.sfx.click();
      fn();
    });
    const name = $('arena-name') as HTMLInputElement;
    name.value = localStorage.getItem(NAME_KEY) ?? '';
    name.addEventListener('change', () => localStorage.setItem(NAME_KEY, name.value.trim().slice(0, 16)));
    for (const b of document.querySelectorAll<HTMLButtonElement>('.arena-kinds button')) {
      b.addEventListener('click', () => {
        game.sfx.click();
        if (this.net && !this.net.isHost) return;
        this.kind = b.dataset.kind as ArenaKind;
        this.net?.setKind(this.kind);
        this.render();
      });
    }
    click('arena-back', () => this.back());
    click('arena-bots', () => this.playBots());
    click('arena-host', () => void this.host(undefined));
    click('arena-join', () => void this.join(($('arena-code') as HTMLInputElement).value));
    click('arena-start', () => this.start());
    click('arena-copy', () => {
      if (this.net) void navigator.clipboard?.writeText(this.net.code).catch(() => {});
      this.status('Code copied — send it to your friends.');
    });
    ($('arena-code') as HTMLInputElement).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.join(($('arena-code') as HTMLInputElement).value);
    });
    $('arena-roster').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-swap]');
      if (b && this.net?.isHost) this.net.switchTeam(+b.dataset.swap!);
    });
    this.render();
    // Coming back from a finished online match: straight back into the same room.
    const back = sessionStorage.getItem(REJOIN_KEY);
    if (back) {
      sessionStorage.removeItem(REJOIN_KEY);
      try {
        const r = JSON.parse(back) as { host: boolean; code: string; kind: ArenaKind };
        this.kind = r.kind;
        this.open();
        if (r.host) void this.host(r.code);
        else void this.join(r.code, 150);
      } catch {
        /* ignore */
      }
    }
  }

  private get playerName() {
    const n = ($('arena-name') as HTMLInputElement).value.trim().slice(0, 16);
    if (n) localStorage.setItem(NAME_KEY, n);
    return n || 'Player';
  }

  open() {
    this.game.hud.showOverlay('title');
    // (Deferred: on a rejoin this runs while the menus are still being built.)
    queueMicrotask(() => this.game.menus.showTab('arena'));
    this.render();
  }

  private back() {
    this.net?.close();
    this.net = null;
    this.status('');
    this.game.menus.refreshLobby();
    this.game.hud.showOverlay('title');
    this.game.menus.showTab('lobby');
    this.render();
  }

  private status(text: string, err = false) {
    const el = $('arena-status');
    el.textContent = text;
    el.classList.toggle('err', err);
  }

  private playBots() {
    if (this.net) return;
    if (isBR(this.kind)) this.game.play();
    else this.game.startArena(this.kind as DMKind, null, [{ id: 1, name: this.playerName, team: 0 }], null);
  }

  private async host(code?: string) {
    if (this.busy || this.net) return;
    this.busy = true;
    this.status('Opening a room…');
    try {
      const net = await Net.host(this.playerName, this.kind, code, this.game.profile.data.skin);
      this.attach(net);
      this.status('Send the code to your friends. Start when everyone is in.');
    } catch (e) {
      this.status(errText(e), true);
    }
    this.busy = false;
    this.render();
  }

  private async join(code: string, tries = 1) {
    code = code.trim().toUpperCase();
    if (this.busy || this.net) return;
    if (code.length !== 5) return this.status('Enter the 5-letter room code.', true);
    this.busy = true;
    for (let i = 0; i < tries; i++) {
      this.status(i ? `Looking for room ${code}… (${i + 1}/${tries})` : `Joining ${code}…`);
      try {
        const net = await Net.join(code, this.playerName, this.game.profile.data.skin);
        // A host still on the results screen turns us away; keep trying until they're back in the lobby.
        await new Promise((r) => setTimeout(r, 1200));
        if (net.closed) {
          net.close();
          throw new Error('That game is already running. Try again when it finishes.');
        }
        this.attach(net);
        this.status('In the lobby. Waiting for the host to start…');
        break;
      } catch (e) {
        if (i === tries - 1) this.status(errText(e), true);
        else await new Promise((r) => setTimeout(r, 2000));
      }
    }
    this.busy = false;
    this.render();
  }

  private attach(net: Net) {
    this.net = net;
    this.kind = net.kind;
    net.onLobby = () => {
      this.kind = net.kind;
      this.render();
    };
    net.onClose = (why) => {
      if (this.game.state !== 'title') return;
      this.net = null;
      this.status(why, true);
      this.render();
    };
    net.onMsg = (m: Msg) => {
      if (m.t === 'start' && !net.isHost) {
        net.started = true;
        if (isBR(m.kind)) this.game.startOnlineBR(m.kind, net, m.roster, m.bots, { tod: m.tod, wx: m.wx }, m.seed ?? 1, m.loot ?? null);
        else this.game.startArena(m.kind as DMKind, net, m.roster, m.bots, { tod: m.tod, wx: m.wx });
      }
    };
  }

  /** Host: deal the bots, tell everyone, go. */
  private start() {
    const net = this.net;
    if (!net?.isHost) return;
    const fill = ($('arena-fill') as HTMLInputElement).checked || net.roster.length < 2;
    const roster: RosterEntry[] = net.roster.map((r) => ({ ...r }));
    const s = this.game.settings.data;
    this.game.env.setup(s.timeOfDay, s.weather);
    const look = { tod: this.game.env.tod, wx: this.game.env.wx };
    net.started = true;
    if (isBR(this.kind)) {
      const bots = planBRBots(this.kind, roster, fill ? Math.max(roster.length, Math.round(s.botCount) + 1) : roster.length);
      const seed = Math.floor(Math.random() * 2 ** 31);
      net.send({ t: 'start', kind: this.kind, roster, bots, ...look, seed, loot: packLoot(this.game) });
      this.game.startOnlineBR(this.kind, net, roster, bots, look, seed, null);
      return;
    }
    const bots = planArenaBots(this.kind as DMKind, roster, fill);
    net.send({ t: 'start', kind: this.kind, roster, bots, ...look });
    this.game.startArena(this.kind as DMKind, net, roster, bots, look);
  }

  /** Before reloading after an online match: remember the room so we go straight back to it. */
  rememberRoom() {
    const a = this.game.arena ?? this.game.obr;
    if (!a?.net) return;
    sessionStorage.setItem(REJOIN_KEY, JSON.stringify({ host: a.net.isHost, code: a.net.code, kind: a.kind }));
  }

  private render() {
    const net = this.net, host = !net || net.isHost;
    for (const b of document.querySelectorAll<HTMLButtonElement>('.arena-kinds button')) {
      b.classList.toggle('on', b.dataset.kind === this.kind);
      b.disabled = !host;
    }
    $('arena-bots').classList.toggle('hidden', !!net);
    $('arena-connect').classList.toggle('hidden', !!net);
    $('arena-lobby').classList.toggle('hidden', !net);
    ($('arena-name') as HTMLInputElement).disabled = !!net;
    if (!net) return;
    $('arena-room').textContent = net.code;
    $('arena-start').classList.toggle('hidden', !net.isHost);
    $('arena-fill-row').classList.toggle('hidden', !net.isHost);
    const me = net.myId;
    const pl = (r: RosterEntry) => `<div class="pl${r.id === me ? ' me' : ''}"><span>${esc(r.name)}${r.id === 1 ? ' <small>(host)</small>' : ''}</span>`
      + (net.isHost && this.kind === 'tdm' ? `<button class="secondary" data-swap="${r.id}">SWITCH</button>` : '') + '</div>';
    const roster = $('arena-roster');
    roster.classList.toggle('ffa', this.kind === 'ffa');
    if (this.kind === 'tdm') {
      roster.innerHTML = [0, 1].map((t) => `<div class="col"><h5 style="color:${TEAM_CSS[t]}">${TEAM_NAMES[t]}</h5>${net.roster.filter((r) => r.team === t).map(pl).join('') || '<div class="hint">Bots</div>'}</div>`).join('');
    } else roster.innerHTML = `<div class="col"><h5>${this.kind === 'brs' ? 'YOUR SQUAD' : 'PLAYERS'} · ${net.roster.length}/8</h5>${net.roster.map(pl).join('')}</div>`;
  }
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function errText(e: unknown) {
  const t = (e as { type?: string })?.type;
  if (t === 'unavailable-id') return 'That room code is taken — try again.';
  if (t === 'network' || t === 'server-error' || t === 'socket-error') return 'Could not reach the matchmaking server. Check your internet connection.';
  if (t === 'browser-incompatible') return webrtcProblem();
  return (e as Error)?.message || 'Something went wrong.';
}

/** Why WebRTC (which online play needs) isn't available, in words a player can act on. */
function webrtcProblem() {
  let embedded = true;
  try {
    embedded = window.top !== window.self;
  } catch {
    /* cross-origin parent: embedded */
  }
  let detail = typeof RTCPeerConnection === 'undefined' ? 'WebRTC is missing' : '';
  if (!detail) {
    try {
      new RTCPeerConnection().close();
    } catch (e) {
      detail = String((e as Error)?.message || e);
    }
  }
  if (embedded) return 'Online play can\'t work inside a preview window (like the claude.ai page or a file preview). Save Stormzone.html, then double-click it in File Explorer so it opens as its own Chrome tab: the address bar should start with file:///.';
  return `This browser has WebRTC turned off (${detail || 'blocked'}). Try turning off ad or privacy extensions, or use another computer: school and work PCs often block it.`;
}
