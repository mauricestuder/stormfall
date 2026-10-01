import { pick, rand, type Rng } from '../core/rng';

/**
 * Furniture for house rooms: kitchens, living rooms, bedrooms and bathrooms, built from boxes in
 * the house's local frame. Pieces stand against the walls and keep doorways, stairs and windows
 * clear, so the rooms stay easy to walk (and fight) through.
 */

/** Box in the house frame: render (and collide unless told not to). */
export type PutFn = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number, collide?: boolean) => void;

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export type RoomKind = 'living' | 'kitchen' | 'bedroom' | 'bath' | 'dining' | 'study';

/** A placed piece: its footprint and the height of its top (loot can sit on tables and counters). */
export interface Placed extends Rect {
  top: number;
  /** Something loot looks right on (tables, counters, desks, beds). */
  surface: boolean;
}

type Side = 'x0' | 'x1' | 'z0' | 'z1';

const SOFA = [0x6a7fa8, 0xa8584a, 0x5a8a6a, 0x8a7a6a, 0x5a6a90, 0xc0a060];
const BLANKET = [0x3f6fd0, 0xd04a4a, 0x4aa86a, 0xe0a030, 0x8a5ac0, 0xe07aa0];
const RUG = [0xa8483a, 0x3a5a8a, 0x8a7a4a, 0x5a8a7a, 0x9a5a8a];
const WOOD = [0xb07a48, 0x9a6a42, 0xc89060, 0xa87850];
const WHITE = 0xf2f2f0, STEEL = 0xc8ccd0, DARK = 0x2a2c30, SCREEN = 0x15171a, TILE = 0xd8e4ea;
/** Colours the Toy Box palette leaves alone: a white fridge stays white. */
export const FURNITURE_COLORS = new Set([WHITE, STEEL, DARK, SCREEN, TILE, 0xfafaf6, 0xe8e8ea, 0xbfe0f0, 0x8ac8e8, 0xbfc4c8, 0x4a4c50, 0x3a3c40, 0xe8e4dc, 0x6a6a70, 0xf0e0a0]);

/**
 * Walls-relative drawing: `u` runs along the wall the piece backs onto, `v` goes out into the
 * room, `y` is up from the floor.
 */
class Along {
  constructor(private put: PutFn, private hit: PutFn, private r: Rect, readonly side: Side, readonly u0: number, private y: number) {}
  private map(u: number, v: number): [number, number] {
    const r = this.r, u1 = this.u0 + u;
    switch (this.side) {
      case 'z0': return [r.x0 + u1, r.z0 + v];
      case 'z1': return [r.x1 - u1, r.z1 - v];
      case 'x0': return [r.x0 + v, r.z1 - u1];
      default: return [r.x1 - v, r.z0 + u1];
    }
  }
  box(ua: number, va: number, ub: number, vb: number, ya: number, yb: number, color: number, collide = true) {
    const [xa, za] = this.map(ua, va), [xb, zb] = this.map(ub, vb);
    this.put(Math.min(xa, xb), this.y + ya, Math.min(za, zb), Math.max(xa, xb), this.y + yb, Math.max(za, zb), color, collide);
  }
  /** Collision only (tables and chairs: you can't walk through them, but the legs stay thin). */
  solid(ua: number, va: number, ub: number, vb: number, ya: number, yb: number) {
    const [xa, za] = this.map(ua, va), [xb, zb] = this.map(ub, vb);
    this.hit(Math.min(xa, xb), this.y + ya, Math.min(za, zb), Math.max(xa, xb), this.y + yb, Math.max(za, zb), 0, true);
  }
  rect(ua: number, va: number, ub: number, vb: number): Rect {
    const [xa, za] = this.map(ua, va), [xb, zb] = this.map(ub, vb);
    return { x0: Math.min(xa, xb), z0: Math.min(za, zb), x1: Math.max(xa, xb), z1: Math.max(za, zb) };
  }
}

interface Piece {
  /** Width along the wall and depth out from it. */
  w: number;
  d: number;
  /** Tall pieces stay out from under windows. */
  tall?: boolean;
  top: number;
  surface?: boolean;
  draw: (a: Along) => void;
}

const legs = (a: Along, w: number, d: number, h: number, color: number, inset = 0.05, t = 0.06) => {
  for (const [u, v] of [[inset, inset], [w - inset - t, inset], [inset, d - inset - t], [w - inset - t, d - inset - t]]) a.box(u, v, u + t, v + t, 0, h, color, false);
};

function table(w: number, d: number, h: number, color: number): Piece {
  return {
    w, d, top: h, surface: true, draw: (a) => {
      a.box(0, 0, w, d, h - 0.05, h, color, false);
      legs(a, w, d, h - 0.05, color);
      a.solid(0, 0, w, d, 0, h);
    },
  };
}

/** `facingWall`: the back is away from the wall (a desk chair), otherwise against it. */
function chair(color: number, facingWall = false): Piece {
  const b0 = facingWall ? 0.4 : 0, b1 = b0 + 0.06;
  return {
    w: 0.46, d: 0.46, top: 0.9, draw: (a) => {
      a.box(0, 0, 0.46, 0.46, 0.42, 0.47, color, false);
      a.box(0.02, b0, 0.44, b1, 0.47, 0.95, color, false);
      legs(a, 0.46, 0.46, 0.42, color, 0.03, 0.04);
      a.solid(0, 0, 0.46, 0.46, 0, 0.47);
    },
  };
}

const PIECES = {
  counter: (rng: Rng): Piece => {
    const w = rand(rng, 2.2, 3.2), body = pick(rng, [WHITE, 0x7a9ab0, 0xb8885a, 0x8aa87a]), top = pick(rng, [DARK, 0xe8e4dc, 0x6a6a70]);
    return {
      w, d: 0.62, top: 0.92, surface: true, draw: (a) => {
        a.box(0, 0, w, 0.6, 0, 0.86, body);
        a.box(0, 0, w, 0.62, 0.86, 0.92, top, false);
        for (let u = 0.05; u + 0.5 < w; u += 0.6) a.box(u, 0.6, u + 0.5, 0.605, 0.1, 0.78, body, false); // cupboard doors
        a.box(w * 0.55, 0.12, w * 0.55 + 0.5, 0.45, 0.905, 0.925, STEEL, false); // sink
        a.box(0, 0, w, 0.35, 1.5, 2.2, body, false); // wall cupboards
      },
    };
  },
  fridge: (): Piece => ({
    w: 0.75, d: 0.7, top: 1.85, tall: true, draw: (a) => {
      a.box(0, 0, 0.75, 0.68, 0, 1.85, WHITE);
      a.box(0.05, 0.68, 0.7, 0.69, 1.2, 1.2 + 0.015, 0xbfc4c8, false); // door line
      a.box(0.6, 0.69, 0.64, 0.73, 1.3, 1.7, STEEL, false);
      a.box(0.6, 0.69, 0.64, 0.73, 0.5, 1.05, STEEL, false);
    },
  }),
  stove: (): Piece => ({
    w: 0.65, d: 0.62, top: 0.92, draw: (a) => {
      a.box(0, 0, 0.65, 0.6, 0, 0.9, STEEL);
      a.box(0, 0, 0.65, 0.6, 0.9, 0.93, DARK, false);
      for (const [u, v] of [[0.1, 0.1], [0.38, 0.1], [0.1, 0.35], [0.38, 0.35]]) a.box(u, v, u + 0.17, v + 0.17, 0.93, 0.945, 0x4a4c50, false);
      a.box(0.08, 0.6, 0.57, 0.61, 0.2, 0.7, 0x3a3c40, false); // oven window
    },
  }),
  sofa: (rng: Rng): Piece => {
    const w = rand(rng, 1.9, 2.4), c = pick(rng, SOFA);
    return {
      w, d: 0.9, top: 0.85, draw: (a) => {
        a.box(0, 0, w, 0.9, 0, 0.42, c);
        a.box(0, 0, w, 0.25, 0.42, 0.85, c);
        a.box(0, 0.25, 0.2, 0.9, 0.42, 0.62, c);
        a.box(w - 0.2, 0.25, w, 0.9, 0.42, 0.62, c);
        for (let u = 0.2; u < w - 0.3; u += (w - 0.4) / 2) a.box(u + 0.02, 0.27, u + (w - 0.4) / 2 - 0.02, 0.88, 0.42, 0.5, c, false); // cushions
      },
    };
  },
  tv: (rng: Rng): Piece => ({
    w: 1.5, d: 0.45, top: 0.5, draw: (a) => {
      a.box(0, 0, 1.5, 0.45, 0, 0.5, pick(rng, WOOD));
      a.box(0.15, 0.12, 1.35, 0.18, 0.55, 1.25, SCREEN, false);
      a.box(0.65, 0.1, 0.85, 0.3, 0.5, 0.55, DARK, false);
    },
  }),
  shelf: (rng: Rng): Piece => {
    const c = pick(rng, WOOD);
    return {
      w: 1.0, d: 0.35, top: 1.9, tall: true, draw: (a) => {
        a.box(0, 0, 1.0, 0.33, 0, 1.9, c);
        for (let i = 0; i < 4; i++) {
          const y = 0.1 + i * 0.45;
          let u = 0.06;
          while (u < 0.9) {
            const bw = 0.05 + rng() * 0.06, bh = 0.22 + rng() * 0.14;
            a.box(u, 0.33, Math.min(0.94, u + bw), 0.345, y, y + bh, pick(rng, [0xc04040, 0x3a6ab0, 0xe0c050, 0x4a9a5a, 0xf0f0f0, 0x6a4a8a]), false);
            u += bw + 0.01;
          }
        }
      },
    };
  },
  bed: (rng: Rng, double: boolean): Piece => {
    const w = double ? 1.6 : 1.0, frame = pick(rng, WOOD), blanket = pick(rng, BLANKET);
    return {
      w, d: 2.1, top: 0.55, surface: true, draw: (a) => {
        a.box(0, 0, w, 0.1, 0, 1.05, frame); // headboard
        a.box(0, 0.1, w, 2.1, 0, 0.32, frame);
        a.box(0.04, 0.1, w - 0.04, 2.06, 0.32, 0.52, WHITE);
        a.box(0.02, 0.8, w - 0.02, 2.08, 0.5, 0.56, blanket, false);
        for (let u = 0.1; u + 0.55 <= w - 0.05; u += 0.7) a.box(u, 0.15, u + 0.55, 0.5, 0.52, 0.64, 0xfafaf6, false); // pillows
      },
    };
  },
  nightstand: (rng: Rng): Piece => ({
    w: 0.45, d: 0.4, top: 0.55, surface: true, draw: (a) => {
      a.box(0, 0, 0.45, 0.4, 0, 0.55, pick(rng, WOOD));
      a.box(0.15, 0.12, 0.3, 0.27, 0.55, 0.85, pick(rng, [0xf0e0a0, 0xe0e0e0]), false); // lamp
    },
  }),
  wardrobe: (rng: Rng): Piece => {
    const c = pick(rng, [...WOOD, WHITE]);
    return {
      w: 1.2, d: 0.6, top: 2.1, tall: true, draw: (a) => {
        a.box(0, 0, 1.2, 0.6, 0, 2.1, c);
        a.box(0.59, 0.6, 0.61, 0.605, 0.1, 2.0, DARK, false);
        a.box(0.5, 0.6, 0.54, 0.64, 0.9, 1.3, STEEL, false);
        a.box(0.66, 0.6, 0.7, 0.64, 0.9, 1.3, STEEL, false);
      },
    };
  },
  desk: (rng: Rng): Piece => {
    const c = pick(rng, WOOD);
    return {
      w: 1.2, d: 0.6, top: 0.75, surface: true, draw: (a) => {
        a.box(0, 0, 1.2, 0.6, 0.7, 0.75, c, false);
        a.box(0, 0, 0.45, 0.6, 0, 0.7, c);
        a.box(1.14, 0, 1.2, 0.6, 0, 0.7, c, false);
        a.solid(0, 0, 1.2, 0.6, 0, 0.75);
        a.box(0.6, 0.08, 1.05, 0.12, 0.75, 1.1, SCREEN, false); // monitor
      },
    };
  },
  bath: (): Piece => ({
    w: 1.7, d: 0.75, top: 0.55, draw: (a) => {
      a.box(0, 0, 1.7, 0.75, 0, 0.55, WHITE);
      a.box(0.08, 0.08, 1.62, 0.67, 0.55, 0.56, 0x8ac8e8, false); // water
      a.box(1.5, 0.02, 1.56, 0.08, 0.55, 1.2, STEEL, false); // tap
    },
  }),
  toilet: (): Piece => ({
    w: 0.45, d: 0.7, top: 0.45, draw: (a) => {
      a.box(0, 0, 0.45, 0.2, 0, 0.8, WHITE);
      a.box(0.05, 0.2, 0.4, 0.68, 0, 0.42, WHITE);
      a.box(0.04, 0.2, 0.41, 0.7, 0.42, 0.45, 0xe8e8ea, false);
    },
  }),
  vanity: (): Piece => ({
    w: 0.8, d: 0.5, top: 0.85, surface: true, draw: (a) => {
      a.box(0, 0, 0.8, 0.5, 0, 0.85, WHITE);
      a.box(0.2, 0.1, 0.6, 0.38, 0.85, 0.87, STEEL, false);
      a.box(0.1, 0, 0.7, 0.02, 1.2, 1.9, 0xbfe0f0, false); // mirror
    },
  }),
};

/** Furnishes one room. `keep` = spots that must stay clear (doorways, stairs); `windows` = sills tall pieces avoid. */
export function furnish(put: PutFn, hit: PutFn, room: Rect, kind: RoomKind, y: number, keep: Rect[], windows: Rect[], rng: Rng): Placed[] {
  const placed: Placed[] = [];
  const free = (r: Rect, tall: boolean) => {
    if (r.x0 < room.x0 - 1e-3 || r.z0 < room.z0 - 1e-3 || r.x1 > room.x1 + 1e-3 || r.z1 > room.z1 + 1e-3) return false;
    const hits = (o: Rect, m: number) => r.x0 < o.x1 + m && r.x1 > o.x0 - m && r.z0 < o.z1 + m && r.z1 > o.z0 - m;
    return !keep.some((o) => hits(o, 0)) && !placed.some((o) => hits(o, 0.08)) && !(tall && windows.some((o) => hits(o, 0.05)));
  };
  const sides: Side[] = ['x0', 'x1', 'z0', 'z1'];
  const wallLen = (s: Side) => (s === 'x0' || s === 'x1' ? room.z1 - room.z0 : room.x1 - room.x0);

  /** Against a wall, somewhere it fits. Returns the Along it was drawn with. */
  const place = (p: Piece, prefer?: Side[]): Along | null => {
    const order = prefer ?? [...sides].sort(() => rng() - 0.5);
    for (const s of order) {
      const len = wallLen(s);
      if (len < p.w) continue;
      const steps = Math.floor((len - p.w) / 0.2) + 1, start = Math.floor(rng() * steps);
      for (let k = 0; k < steps; k++) {
        const u0 = ((start + k) % steps) * 0.2;
        const a = new Along(put, hit, room, s, u0, y);
        const r = a.rect(0, 0, p.w, p.d);
        if (!free(r, !!p.tall)) continue;
        p.draw(a);
        placed.push({ ...r, top: y + p.top, surface: !!p.surface });
        return a;
      }
    }
    return null;
  };
  /** Free-standing, relative to a piece already against the wall (a coffee table in front of the sofa). */
  const inFront = (a: Along, p: Piece, u: number, v: number) => {
    const r = a.rect(u, v, u + p.w, v + p.d);
    if (!free(r, false)) return;
    p.draw(new Along(put, hit, shiftRect(room, a.side, v), a.side, a.u0 + u, y));
    placed.push({ ...r, top: y + p.top, surface: !!p.surface });
  };
  const rug = () => {
    const w = room.x1 - room.x0, d = room.z1 - room.z0;
    if (w < 2.6 || d < 2.6) return;
    const cx = (room.x0 + room.x1) / 2, cz = (room.z0 + room.z1) / 2, rw = Math.min(2.6, w - 1.4) / 2, rd = Math.min(1.9, d - 1.4) / 2;
    put(cx - rw, y, cz - rd, cx + rw, y + 0.015, cz + rd, pick(rng, RUG), false);
  };

  switch (kind) {
    case 'kitchen': {
      const c = PIECES.counter(rng), a = place(c);
      place(PIECES.fridge());
      place(PIECES.stove());
      if (a && room.x1 - room.x0 > 3.2 && room.z1 - room.z0 > 3.2) {
        const t = table(1.3, 0.85, 0.76, pick(rng, WOOD)), ca = chair(pick(rng, WOOD));
        diningSet(t, ca);
      }
      break;
    }
    case 'dining': {
      diningSet(table(1.6, 0.9, 0.76, pick(rng, WOOD)), chair(pick(rng, WOOD)));
      place(PIECES.shelf(rng));
      break;
    }
    case 'living': {
      rug();
      const s = PIECES.sofa(rng), a = place(s);
      if (a) inFront(a, table(1.0, 0.55, 0.42, pick(rng, WOOD)), s.w / 2 - 0.5, 1.4);
      place(PIECES.tv(rng));
      place(PIECES.shelf(rng));
      break;
    }
    case 'bedroom': {
      rug();
      const double = room.x1 - room.x0 > 3 && room.z1 - room.z0 > 3, b = PIECES.bed(rng, double), a = place(b);
      if (a) inFront(a, PIECES.nightstand(rng), -0.55, 0);
      place(PIECES.wardrobe(rng));
      if (rng() < 0.6) {
        const d = PIECES.desk(rng), da = place(d);
        if (da) inFront(da, chair(pick(rng, WOOD), true), 0.6, 0.62);
      }
      break;
    }
    case 'study': {
      const d = PIECES.desk(rng), da = place(d);
      if (da) inFront(da, chair(pick(rng, WOOD), true), 0.6, 0.62);
      place(PIECES.shelf(rng));
      place(PIECES.shelf(rng));
      break;
    }
    case 'bath': {
      put(room.x0, y, room.z0, room.x1, y + 0.012, room.z1, TILE, false); // tiled floor
      place(PIECES.bath());
      place(PIECES.toilet());
      place(PIECES.vanity());
      break;
    }
  }
  return placed;

  /** A table in the middle of the room with chairs on its long sides. */
  function diningSet(t: Piece, c: Piece) {
    const cx = (room.x0 + room.x1) / 2 + rand(rng, -0.3, 0.3), cz = (room.z0 + room.z1) / 2 + rand(rng, -0.3, 0.3);
    const alongX = room.x1 - room.x0 >= room.z1 - room.z0, w = alongX ? t.w : t.d, d = alongX ? t.d : t.w;
    const r = { x0: cx - w / 2, z0: cz - d / 2, x1: cx + w / 2, z1: cz + d / 2 };
    const around = { x0: r.x0 - (alongX ? 0 : 0.55), z0: r.z0 - (alongX ? 0.55 : 0), x1: r.x1 + (alongX ? 0 : 0.55), z1: r.z1 + (alongX ? 0.55 : 0) };
    if (!free(around, false)) return;
    const a = new Along(put, hit, { x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1 }, alongX ? 'z0' : 'x1', 0, y);
    t.draw(a);
    placed.push({ ...r, top: y + t.top, surface: true });
    // Chairs: two per long side, facing the table.
    const L = alongX ? w : d;
    for (const f of [0.25, 0.75]) {
      const m = f * L - c.w / 2;
      if (alongX) {
        c.draw(new Along(put, hit, { x0: r.x0 + m, z0: r.z0 - 0.55, x1: r.x0 + m + c.w, z1: r.z0 - 0.09 }, 'z0', 0, y));
        c.draw(new Along(put, hit, { x0: r.x0 + m, z0: r.z1 + 0.09, x1: r.x0 + m + c.w, z1: r.z1 + 0.55 }, 'z1', 0, y));
      } else {
        c.draw(new Along(put, hit, { x0: r.x0 - 0.55, z0: r.z0 + m, x1: r.x0 - 0.09, z1: r.z0 + m + c.w }, 'x0', 0, y));
        c.draw(new Along(put, hit, { x0: r.x1 + 0.09, z0: r.z0 + m, x1: r.x1 + 0.55, z1: r.z0 + m + c.w }, 'x1', 0, y));
      }
    }
    placed.push({ ...around, top: y + 0.5, surface: false });
  }
}

/** The room rect with the wall on `side` moved `v` metres into the room. */
function shiftRect(r: Rect, side: Side, v: number): Rect {
  switch (side) {
    case 'z0': return { ...r, z0: r.z0 + v };
    case 'z1': return { ...r, z1: r.z1 - v };
    case 'x0': return { ...r, x0: r.x0 + v };
    default: return { ...r, x1: r.x1 - v };
  }
}
