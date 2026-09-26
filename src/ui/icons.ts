import type { WeaponId } from '../weapons/Weapon';

/** Side-on silhouettes of every gun (100 × 40 box), for the weapon slots and inventory. */
const GUNS: Record<WeaponId, string> = {
  pistol: 'M22 9h52v10H48l-3 3h-6l-3 13H24l4-16h-6z M44 19c0 6-4 8-9 7',
  revolver: 'M44 11h46v6H44z M30 8h18v15H30z M31 5h6v4h-6z M20 12h12l-3 23H16l4-16z',
  smg: 'M16 12h58v11H16z M74 15h16v5H74z M4 13h13v6H9l-3 4H4z M34 23h8l-2 12h-8z M52 23h8l-1 16h-7z M24 8h24v4H24z',
  burst: 'M3 13h17v10l-15 2z M20 11h48v12H20z M68 13h18v8H68z M86 15h12v4H86z M28 23h7l-2 11h-7z M46 23h8l3 14h-8z M36 5h12v6H36z',
  ar: 'M2 12h18v10L4 24z M20 10h46v12H20z M66 12h18v9H66z M84 15h14v4H84z M26 22h7l-2 11h-7z M44 22h8l5 14h-8z M30 6h20v4H30z',
  lmg: 'M2 12h16v11l-13 2z M18 9h50v14H18z M68 12h20v9H68z M88 14h10v5H88z M26 23h7l-2 11h-7z M40 23h16v13H40z M72 21l-5 14h3l5-14z M78 21l3 14h3l-3-14z M24 5h30v4H24z',
  shotgun: 'M2 13h20v9L4 25z M22 11h30v11H22z M52 12h44v5H52z M54 17h26v6H54z M28 22h7l-2 11h-7z',
  dmr: 'M2 12h20v10L4 25z M22 11h36v11H22z M58 13h38v5H58z M30 22h7l-2 11h-7z M44 22h7l1 11h-7z M28 3h28v6H28z M32 9h4v2h-4z M48 9h4v2h-4z',
  sniper: 'M1 12h22v10L3 26z M23 11h30v11H23z M53 13h45v4H53z M30 22h7l-2 11h-7z M44 22h6v8h-6z M24 1h34v8H24z M22 2h4v6h-4z M56 2h4v6h-4z M34 9h4v2h-4z M46 9h4v2h-4z',
  rocket: 'M6 10h84v13H6z M90 8h8v17h-8z M2 12h6v9H2z M36 23h8l-2 11h-8z M54 23h7l-2 9h-7z M40 4h14v6H40z',
};

export function gunIcon(id: WeaponId) {
  return `<svg class="gun-ico" viewBox="0 0 100 40" aria-hidden="true"><path d="${GUNS[id]}" fill="currentColor" fill-rule="nonzero"/></svg>`;
}

export const FIST_ICON = `<svg class="gun-ico fist" viewBox="0 0 100 40" aria-hidden="true"><path fill="currentColor" d="M36 8h28a6 6 0 0 1 6 6v12a8 8 0 0 1-8 8H40a8 8 0 0 1-8-8V12a4 4 0 0 1 4-4z M38 8v-2h7v2z M47 8v-3h7v3z M56 8v-2h7v2z" /><path d="M41 14v8 M50 14v8 M59 14v8" stroke="rgba(0,0,0,0.35)" stroke-width="2"/></svg>`;
