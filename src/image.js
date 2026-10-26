const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const { warn } = require('./logger');

const FONT_URL = 'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf';

// Shared colors + a rotating bg/accent theme. Consecutive posts get different
// palettes so the feed never shows the same-looking chart twice in a row.
const BASE = {
  grid: '#232b37',
  up: '#0ecb81',
  down: '#f6465d',
  text: '#eaecef',
  muted: '#848e9c',
};

const THEMES = [
  { name: 'amber', bg: '#0b0e11', accent: '#f0b90b' },
  { name: 'sky', bg: '#0a1120', accent: '#38bdf8' },
  { name: 'violet', bg: '#120f1e', accent: '#a78bfa' },
];

let C = { ...BASE, ...THEMES[0] };

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

const W = 1280;
const H = 720;

let font = null;

// Render containers (Render's free image) often ship no fonts, so fall back to
// a downloaded DejaVu Sans before giving up on text entirely.
async function ensureFont() {
  if (font) return font;
  const families = GlobalFonts.families.map((f) => f.family);
  const preferred = ['DejaVu Sans', 'Liberation Sans', 'Arial', 'Roboto', 'Ubuntu', 'Helvetica'];
  const found = preferred.find((f) => families.includes(f));
  if (found) {
    font = `"${found}"`;
    return font;
  }
  try {
    const fontPath = path.join(os.tmpdir(), 'bot-dejavu-sans.ttf');
    if (!fs.existsSync(fontPath) || fs.statSync(fontPath).size < 100000) {
      const res = await fetch(FONT_URL, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(fontPath, Buffer.from(await res.arrayBuffer()));
    }
    GlobalFonts.registerFromPath(fontPath, 'BotSans');
    font = '"BotSans"';
  } catch (err) {
    warn(`image: font download failed (${err.message}); using generic sans-serif`);
    font = 'sans-serif';
  }
  return font;
}

function fmtPrice(v) {
  if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (v >= 1) return v.toFixed(2);
  return v.toPrecision(4);
}

function fmtUsd(v) {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1000) return `$${Math.round(v).toLocaleString('en-US')}`;
  return `$${v}`;
}

function setFont(ctx, size, weight = '') {
  ctx.font = `${weight ? weight + ' ' : ''}${size}px ${font}`;
}

function drawBackground(ctx, title, subtitle) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  const grad = ctx.createLinearGradient(0, 0, 0, 300);
  grad.addColorStop(0, hexToRgba(C.accent, 0.1));
  grad.addColorStop(1, hexToRgba(C.accent, 0));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 300);

  setFont(ctx, 44, 'bold');
  ctx.fillStyle = C.text;
  ctx.fillText(title, 48, 70);
  setFont(ctx, 22);
  ctx.fillStyle = C.muted;
  ctx.fillText(subtitle, 48, 104);
}

function drawFooter(ctx, note) {
  setFont(ctx, 20);
  ctx.fillStyle = C.muted;
  ctx.fillText('Auto-posted by AI Market Bot', 48, H - 28);
  const label = `${note} - Data: Binance Spot API`;
  ctx.textAlign = 'right';
  ctx.fillText(label, W - 48, H - 28);
  ctx.textAlign = 'left';
}

function drawChip(ctx, x, y, text, bgColor, textColor) {
  setFont(ctx, 24, 'bold');
  const w = ctx.measureText(text).width + 28;
  const h = 40;
  ctx.fillStyle = bgColor;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, 8) : ctx.rect(x, y, w, h);
  ctx.fill();
  ctx.fillStyle = textColor;
  ctx.fillText(text, x + 14, y + 27);
  return w;
}

async function renderPriceChart(snap) {
  await ensureFont();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const klines = snap.klines;
  const main = snap.tickers.find((t) => t.symbol === snap.mainSymbol) || snap.tickers[0];
  const lastClose = klines[klines.length - 1].close;
  const pct = main ? main.priceChangePercent : 0;
  const up = pct >= 0;

  drawBackground(
    ctx,
    `${snap.mainSymbol}  ${fmtPrice(lastClose)}`,
    `1h candles - last 48h - ${snap.fetchedAt.slice(0, 16)} UTC`
  );
  drawChip(
    ctx,
    48,
    128,
    `24h ${up ? '+' : ''}${pct.toFixed(2)}%`,
    up ? 'rgba(14,203,129,0.18)' : 'rgba(246,70,93,0.18)',
    up ? C.up : C.down
  );
  setFont(ctx, 22);
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'right';
  if (main) {
    ctx.fillText(`24h High ${fmtPrice(main.highPrice)}`, W - 48, 62);
    ctx.fillText(`24h Low  ${fmtPrice(main.lowPrice)}`, W - 48, 92);
    ctx.fillText(`24h Vol  ${fmtUsd(main.quoteVolume)}`, W - 48, 122);
  }
  ctx.textAlign = 'left';

  const chart = { x: 48, y: 200, w: W - 48 - 150, h: 320 };
  const vol = { y: 560, h: 90 };

  let min = Infinity;
  let max = -Infinity;
  for (const k of klines) {
    if (k.low < min) min = k.low;
    if (k.high > max) max = k.high;
  }
  const pad = (max - min) * 0.05 || max * 0.01;
  min -= pad;
  max += pad;
  const yOf = (price) => chart.y + ((max - price) / (max - min)) * chart.h;

  // grid + right-side price axis
  setFont(ctx, 18);
  ctx.strokeStyle = C.grid;
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'left';
  for (let i = 0; i <= 4; i++) {
    const y = chart.y + (chart.h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(chart.x, y);
    ctx.lineTo(chart.x + chart.w, y);
    ctx.stroke();
    ctx.fillText(fmtPrice(max - ((max - min) / 4) * i), chart.x + chart.w + 12, y + 6);
  }

  const step = chart.w / klines.length;
  const bodyW = Math.max(2, step * 0.62);
  const maxVol = Math.max(...klines.map((k) => k.volume));

  klines.forEach((k, i) => {
    const cx = chart.x + step * i + step / 2;
    const bull = k.close >= k.open;
    const color = bull ? C.up : C.down;

    // volume bar
    const vh = (k.volume / maxVol) * vol.h;
    ctx.fillStyle = bull ? 'rgba(14,203,129,0.28)' : 'rgba(246,70,93,0.28)';
    ctx.fillRect(cx - bodyW / 2, vol.y + vol.h - vh, bodyW, vh);

    // wick
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, yOf(k.high));
    ctx.lineTo(cx, yOf(k.low));
    ctx.stroke();

    // body
    const yOpen = yOf(k.open);
    const yClose = yOf(k.close);
    const top = Math.min(yOpen, yClose);
    const height = Math.max(2, Math.abs(yClose - yOpen));
    ctx.fillStyle = color;
    ctx.fillRect(cx - bodyW / 2, top, bodyW, height);
  });

  // last price line + label
  const ly = yOf(lastClose);
  ctx.strokeStyle = C.accent;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(chart.x, ly);
  ctx.lineTo(chart.x + chart.w, ly);
  ctx.stroke();
  ctx.setLineDash([]);
  const label = fmtPrice(lastClose);
  setFont(ctx, 18, 'bold');
  const lw = ctx.measureText(label).width + 16;
  ctx.fillStyle = C.accent;
  ctx.fillRect(chart.x + chart.w + 4, ly - 13, lw, 26);
  ctx.fillStyle = '#000000';
  ctx.fillText(label, chart.x + chart.w + 12, ly + 6);

  drawFooter(ctx, `${snap.fetchedAt.slice(0, 16)} UTC`);
  return canvas.toBuffer('image/png');
}

async function renderMoversChart(snap) {
  await ensureFont();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const rows = [...snap.tickers].sort((a, b) => b.priceChangePercent - a.priceChangePercent);

  drawBackground(
    ctx,
    '24h Market Movers',
    `Binance spot - ${snap.fetchedAt.slice(0, 16)} UTC`
  );

  const listX = 48;
  const barX = 300;
  const barMaxW = W - barX - 220;
  const top = 190;
  const rowH = Math.min(90, (H - top - 90) / rows.length);
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.priceChangePercent)), 1);

  rows.forEach((r, i) => {
    const y = top + rowH * i;
    const up = r.priceChangePercent >= 0;
    const color = up ? C.up : C.down;

    setFont(ctx, 28, 'bold');
    ctx.fillStyle = C.text;
    ctx.fillText(r.symbol.replace('USDT', ''), listX, y + rowH / 2 + 10);

    setFont(ctx, 20);
    ctx.fillStyle = C.muted;
    ctx.fillText(fmtPrice(r.lastPrice), listX + 140, y + rowH / 2 + 10);

    const barW = (Math.abs(r.priceChangePercent) / maxAbs) * barMaxW;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.roundRect
      ? (ctx.beginPath(), ctx.roundRect(barX, y + rowH / 2 - 14, barW, 28, 6), ctx.fill())
      : ctx.fillRect(barX, y + rowH / 2 - 14, barW, 28);
    ctx.globalAlpha = 1;

    setFont(ctx, 22, 'bold');
    ctx.fillStyle = color;
    const text = `${up ? '+' : ''}${r.priceChangePercent.toFixed(2)}%`;
    ctx.fillText(text, barX + barW + 16, y + rowH / 2 + 8);
  });

  drawFooter(ctx, `${snap.fetchedAt.slice(0, 16)} UTC`);
  return canvas.toBuffer('image/png');
}

// Semicircular gauge for the Fear & Greed Index - the rotating secondary
// chart that replaces the movers board on alternating hours.
async function renderFearGreedChart(fg, fetchedAt) {
  await ensureFont();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  drawBackground(ctx, 'Crypto Fear & Greed Index', `alternative.me - ${String(fetchedAt).slice(0, 16)} UTC`);

  const cx = W / 2;
  const cy = 430;
  const r = 240;
  const zones = [
    [0, 24, '#f6465d', 'Extreme Fear'],
    [25, 44, '#fd9b4a', 'Fear'],
    [45, 55, '#f0b90b', 'Neutral'],
    [56, 75, '#67c587', 'Greed'],
    [76, 100, '#0ecb81', 'Extreme Greed'],
  ];
  const angleOf = (v) => Math.PI + (v / 100) * Math.PI;
  const zoneColorOf = (v) => (zones.find(([a, b]) => v >= a && v <= b) || zones[2])[2];
  const zoneLabelOf = (v) => (zones.find(([a, b]) => v >= a && v <= b) || zones[2])[3];

  for (const [a, b, color] of zones) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 42;
    ctx.arc(cx, cy, r, angleOf(a), angleOf(b));
    ctx.stroke();
  }

  // scale labels
  setFont(ctx, 20);
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'center';
  for (const v of [0, 25, 50, 75, 100]) {
    const ang = angleOf(v);
    ctx.fillText(String(v), cx + Math.cos(ang) * (r + 42), cy + Math.sin(ang) * (r + 42) + 6);
  }

  // needle
  const ang = angleOf(fg.value);
  ctx.strokeStyle = C.text;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(ang) * (r - 34), cy + Math.sin(ang) * (r - 34));
  ctx.stroke();
  ctx.fillStyle = C.accent;
  ctx.beginPath();
  ctx.arc(cx, cy, 15, 0, Math.PI * 2);
  ctx.fill();

  // big reading + zone label
  const color = zoneColorOf(fg.value);
  setFont(ctx, 84, 'bold');
  ctx.fillStyle = color;
  ctx.fillText(String(fg.value), cx, cy + 130);
  setFont(ctx, 32, 'bold');
  ctx.fillText(zoneLabelOf(fg.value), cx, cy + 175);
  if (fg.previous !== null && fg.previous !== undefined) {
    const d = fg.value - fg.previous;
    setFont(ctx, 22);
    ctx.fillStyle = C.muted;
    ctx.fillText(`Yesterday: ${fg.previous} (${d === 0 ? 'unchanged' : `${d > 0 ? 'up' : 'down'} ${Math.abs(d)}`})`, cx, cy + 215);
  }
  ctx.textAlign = 'left';

  drawFooter(ctx, `${String(fetchedAt).slice(0, 16)} UTC`);
  return canvas.toBuffer('image/png');
}

// One lead chart + one secondary chart per post, both chosen by the hour seed
// so consecutive posts never carry the same visuals: the lead is the spotlight
// coin when the editor picked one, else a rotating major (scheduler decides);
// the secondary alternates between the 24h movers board and the Fear & Greed
// gauge, and the palette cycles through three themes. Every render degrades
// gracefully - a failed chart is skipped as long as one image survives.
async function renderPostImages({ leadSnap, majorsSnap, fearGreed = null, hourSeed = 0 }) {
  const stamp = Date.now();
  C = { ...BASE, ...THEMES[hourSeed % THEMES.length] };
  const out = [];
  const tryRender = async (render, tag) => {
    try {
      const buffer = await render();
      const name = `square-${tag}-${stamp}.png`;
      const p = path.join(os.tmpdir(), name);
      fs.writeFileSync(p, buffer);
      out.push({ buffer, name, path: p });
    } catch (err) {
      warn(`image: ${tag} render failed: ${err.message}`);
    }
  };

  await tryRender(() => renderPriceChart(leadSnap), 'chart');
  const gauge = hourSeed % 2 === 1 && fearGreed;
  if (gauge) {
    await tryRender(() => renderFearGreedChart(fearGreed, majorsSnap.fetchedAt), 'feargreed');
    if (out.length < 2) await tryRender(() => renderMoversChart(majorsSnap), 'movers');
  } else {
    await tryRender(() => renderMoversChart(majorsSnap), 'movers');
    if (out.length < 2 && fearGreed) {
      await tryRender(() => renderFearGreedChart(fearGreed, majorsSnap.fetchedAt), 'feargreed');
    }
  }

  if (out.length === 0) throw new Error('failed to render any post image');
  return out;
}

module.exports = { renderPostImages };
