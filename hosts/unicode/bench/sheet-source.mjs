// How fast Canvas2D draws sprite-sheet cells from an <img> against an ImageBitmap,
// in headless Chromium: 16,000 cells a frame from a 4096px sheet, 10 frames a run.
//
//   node hosts/unicode/bench/sheet-source.mjs
import { chromium } from 'playwright-core';

const RUNS = 7;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.evaluate(async () => {
    const size = 4096, pitch = 32, cols = size / pitch;
    const src = new OffscreenCanvas(size, size);
    const g = src.getContext('2d');
    for (let i = 0; i < cols * cols; i++) {
      g.fillStyle = `hsl(${i % 360} 60% 50%)`;
      g.fillRect((i % cols) * pitch, Math.floor(i / cols) * pitch, pitch - 2, pitch - 2);
    }
    const blob = await src.convertToBlob({ type: 'image/png' });
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    await img.decode();
    const bitmap = await createImageBitmap(blob);
    const dst = document.createElement('canvas');
    dst.width = 1600;
    dst.height = 1000;
    document.body.append(dst);
    const ctx = dst.getContext('2d');
    window.drawFrom = (which) => {
      const from = which === 'img' ? img : bitmap;
      const t0 = performance.now();
      for (let f = 0; f < 10; f++) {
        for (let i = 0; i < 16000; i++) {
          const s = (i * 7919) % (cols * cols);
          ctx.drawImage(from, (s % cols) * pitch, Math.floor(s / cols) * pitch, 30, 30,
                        (i % 160) * 10, Math.floor(i / 160) * 10, 10, 10);
        }
      }
      ctx.getImageData(0, 0, 1, 1);
      return (performance.now() - t0) / 10;
    };
    window.drawFrom('img');
    window.drawFrom('bitmap');
  });
  const runs = { img: [], bitmap: [] };
  for (let k = 0; k < RUNS; k++) {
    for (const which of ['img', 'bitmap']) runs[which].push(await page.evaluate((w) => window.drawFrom(w), which));
    console.log(`${k + 1}/${RUNS}  img ${runs.img[k].toFixed(1).padStart(6)} ms/frame   bitmap ${runs.bitmap[k].toFixed(1).padStart(6)} ms/frame`);
  }
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  console.log(`median  img ${median(runs.img).toFixed(1).padStart(6)} ms/frame   bitmap ${median(runs.bitmap).toFixed(1).padStart(6)} ms/frame`);
} finally {
  await browser.close();
}
