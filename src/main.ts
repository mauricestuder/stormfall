// The game (and three.js) load as a separate chunk so the loading screen appears instantly.
const fill = document.getElementById('load-fill')!;
const label = document.getElementById('load-label')!;
const loadingEl = document.getElementById('loading')!;

const progress = (frac: number, text: string) => {
  fill.style.width = `${Math.round(frac * 100)}%`;
  label.textContent = text;
};

// Home-screen icon for "Add to Home Screen" on iPhone (drawn here so the game stays one file).
{
  const cv = document.createElement('canvas');
  cv.width = cv.height = 180;
  const c = cv.getContext('2d')!;
  const g = c.createLinearGradient(0, 0, 0, 180);
  g.addColorStop(0, '#3a1f7a');
  g.addColorStop(1, '#0b0f16');
  c.fillStyle = g;
  c.fillRect(0, 0, 180, 180);
  c.fillStyle = '#ffcf3a';
  c.beginPath();
  for (const [x, y] of [[104, 18], [52, 100], [86, 100], [70, 162], [130, 72], [96, 72], [118, 18]]) c.lineTo(x, y);
  c.fill();
  document.getElementById('touch-icon')?.setAttribute('href', cv.toDataURL('image/png'));
}
// iOS: stop the page from rubber-banding or zooming on double taps.
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
document.addEventListener('dblclick', (e) => e.preventDefault());

progress(0.02, 'Loading engine');
const { Game } = await import('./game/Game');
const game = new Game(document.getElementById('app')!);
await game.init(progress);
game.start();
loadingEl.style.opacity = '0';
setTimeout(() => loadingEl.remove(), 450);

// Handy for debugging from the console.
(window as unknown as { game: typeof game }).game = game;
export {};
