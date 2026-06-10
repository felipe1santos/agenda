// Gera os ícones PWA (PNG) sem dependências externas: encoder PNG manual
// (zlib nativo do Node para compressão) + um glifo de "calendário" desenhado
// pixel a pixel. Rode com: node scripts/generate-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

const COLORS = {
  blue: [59, 130, 246, 255],   // --primary
  white: [255, 255, 255, 255],
  red: [239, 68, 68, 255],     // --cor-especial
};

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------- PNG chunks ----------
function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, getPixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // sem filtro nessa linha
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixel(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- Geometria ----------
function insideRoundedRect(x, y, rx, ry, rw, rh, radius) {
  if (x < rx || x > rx + rw || y < ry || y > ry + rh) return false;
  const cx = Math.min(Math.max(x, rx + radius), rx + rw - radius);
  const cy = Math.min(Math.max(y, ry + radius), ry + rh - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

// Desenha um "card" de calendário azul/branco/vermelho dentro de um
// quadrado `size`x`size`. `maskable` aumenta a margem (safe zone) pro
// glifo não ser cortado pela máscara do Android.
function makeCalendarIcon(size, maskable) {
  const margin = size * (maskable ? 0.22 : 0.13);
  const cardLeft = margin;
  const cardTop = margin + (size - 2 * margin) * 0.06;
  const cardW = size - margin * 2;
  const cardH = size - margin - cardTop;
  const radius = cardW * 0.09;
  const headerH = cardH * 0.30;
  const headerBottom = cardTop + headerH;

  // "argolas" do calendário, acima do card
  const ringW = cardW * 0.09;
  const ringH = headerH * 0.85;
  const ring1cx = cardLeft + cardW * 0.27;
  const ring2cx = cardLeft + cardW * 0.73;
  const ringTop = cardTop - ringH * 0.4;
  const ringRadius = ringW * 0.4;

  // grade de "compromissos" (3x2 quadradinhos)
  const gridTop = headerBottom + cardH * 0.10;
  const gridLeft = cardLeft + cardW * 0.12;
  const gridW = cardW * 0.76;
  const gridH = cardBottomMinus(cardTop, cardH) - gridTop - cardH * 0.06;

  function cardBottomMinus(top, h) { return top + h; }

  const cols = 3, rows = 2;
  const cellW = gridW / cols, cellH = gridH / rows;
  const dotSize = Math.min(cellW, cellH) * 0.6;

  return function getPixel(x, y) {
    // argolas
    if (insideRoundedRect(x, y, ring1cx - ringW / 2, ringTop, ringW, ringH, ringRadius)) return COLORS.white;
    if (insideRoundedRect(x, y, ring2cx - ringW / 2, ringTop, ringW, ringH, ringRadius)) return COLORS.white;

    if (insideRoundedRect(x, y, cardLeft, cardTop, cardW, cardH, radius)) {
      if (y < headerBottom) return COLORS.red;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cx = gridLeft + cellW * (c + 0.5);
          const cy = gridTop + cellH * (r + 0.5);
          if (Math.abs(x - cx) < dotSize / 2 && Math.abs(y - cy) < dotSize / 2) return COLORS.blue;
        }
      }
      return COLORS.white;
    }
    return COLORS.blue;
  };
}

function generate(name, size, maskable) {
  const png = encodePNG(size, size, makeCalendarIcon(size, maskable));
  const outPath = path.join(OUT_DIR, name);
  fs.writeFileSync(outPath, png);
  console.log(`gerado ${outPath} (${size}x${size}${maskable ? ', maskable' : ''})`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
generate('icon-192.png', 192, false);
generate('icon-512.png', 512, false);
generate('icon-maskable-512.png', 512, true);
generate('apple-touch-icon-180.png', 180, false);
