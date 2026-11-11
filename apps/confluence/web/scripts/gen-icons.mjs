/**
 * gen-icons.mjs — regenerate the full adaptive app-icon set from the brand mark.
 *
 * The brand mark (public/brand-mark.svg) is cyan/green on transparency with a
 * white center node — great on dark surfaces, but it washes out on a light one.
 * So every launcher/tab/home-screen icon is composited onto the brand's native
 * dark chip (#090d14), which blends into dark UIs and reads as a badge on light
 * UIs. The maskable icon is full-bleed dark with the mark inside the safe zone.
 *
 * Run:  node scripts/gen-icons.mjs
 * Requires: sharp (already a dependency).
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const pub = path.join(root, "public");
const markPath = path.join(pub, "brand-mark.svg");
if (!fs.existsSync(markPath)) {
  console.error("Missing public/brand-mark.svg");
  process.exit(1);
}
const markSvg = fs.readFileSync(markPath);

const BG = "#090d14"; // matches manifest background_color

const roundedChip = (size, radiusFrac = 0.22) => {
  const r = Math.round(size * radiusFrac);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<rect x="0" y="0" width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${BG}"/></svg>`,
  );
};
const solidSquare = (size) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<rect width="${size}" height="${size}" fill="${BG}"/></svg>`,
  );

async function renderMark(px) {
  return sharp(markSvg, { density: 384 }).resize(px, px, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}

// chip icon: rounded dark tile + mark at `inner` scale
async function chipIcon(size, file, { radiusFrac = 0.22, innerFrac = 0.72 } = {}) {
  const inner = Math.round(size * innerFrac);
  const mark = await renderMark(inner);
  const off = Math.round((size - inner) / 2);
  await sharp(roundedChip(size, radiusFrac))
    .composite([{ input: mark, top: off, left: off }])
    .png()
    .toFile(path.join(pub, file));
}

// maskable: full-bleed dark, mark within the ~80% safe zone
async function maskableIcon(size, file) {
  const inner = Math.round(size * 0.62);
  const mark = await renderMark(inner);
  const off = Math.round((size - inner) / 2);
  await sharp(solidSquare(size))
    .composite([{ input: mark, top: off, left: off }])
    .png()
    .toFile(path.join(pub, file));
}

const CHIP = [
  ["favicon-16.png", 16],
  ["favicon-32.png", 32],
  ["icon-48.png", 48],
  ["icon-72.png", 72],
  ["icon-96.png", 96],
  ["icon-144.png", 144],
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["apple-touch-icon.png", 180],
];

const run = async () => {
  for (const [file, size] of CHIP) {
    // smaller favicons look better with tighter corners
    const radiusFrac = size <= 48 ? 0.16 : 0.22;
    await chipIcon(size, file, { radiusFrac });
    console.log("wrote", file, `${size}x${size}`);
  }
  await maskableIcon(512, "icon-maskable-512.png");
  console.log("wrote icon-maskable-512.png 512x512 (maskable, full-bleed)");
  console.log("Done. Icons regenerated in public/. Re-run your build to propagate to out/, android, ios.");
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
