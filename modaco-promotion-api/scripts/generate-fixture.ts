import { createWriteStream, promises as fsp } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';

const CATEGORIES = ['Accessories', 'Apparel', 'Footwear', 'Home', 'Electronics'];

function parseArgs(): { rows: number; out: string } {
  const argv = process.argv.slice(2);
  const rowsIndex = argv.indexOf('--rows');
  const outIndex = argv.indexOf('--out');
  const rows = rowsIndex >= 0 ? Number(argv[rowsIndex + 1]) : 500000;
  const out =
    outIndex >= 0 ? argv[outIndex + 1] : join(process.cwd(), 'data', 'fixtures', 'products.csv');
  return { rows, out };
}

async function main(): Promise<void> {
  const { rows, out } = parseArgs();
  await fsp.mkdir(join(out, '..'), { recursive: true });
  const ws = createWriteStream(out);
  ws.write('sku,name,category,basePrice,stockQuantity\n');
  for (let i = 1; i <= rows; i++) {
    const sku = `SKU-${String(i).padStart(8, '0')}`;
    const category = CATEGORIES[i % CATEGORIES.length];
    const basePrice = Math.round((5 + (i % 495) * 1.01) * 100) / 100;
    const stockQuantity = i % 200;
    const line = `${sku},Product ${i},${category},${basePrice},${stockQuantity}\n`;
    if (!ws.write(line)) {
      await once(ws, 'drain');
    }
  }
  ws.end();
  await once(ws, 'close');
  console.log(`wrote ${rows} rows to ${out}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
