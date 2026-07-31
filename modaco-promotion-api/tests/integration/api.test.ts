import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { buildApp } from '../../src/app';
import { env } from '../../src/config/env';
import { prisma } from '../../src/db/client';

let server: Server;
let app: Awaited<ReturnType<typeof buildApp>>;

const day = 24 * 60 * 60 * 1000;
const activeWindow = {
  startAt: new Date(Date.now() - day).toISOString(),
  endAt: new Date(Date.now() + day).toISOString(),
};

beforeAll(async () => {
  app = await buildApp();
  server = app.app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await app.cache.quit();
  await prisma.$disconnect();
});

async function resetDb(): Promise<void> {
  await prisma.promotion.deleteMany();
  await prisma.product.deleteMany();
  await prisma.ingestionJob.deleteMany();
  await app.cache.bumpGeneration();
}

async function createProduct(
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await request(server)
    .post('/products')
    .send({
      sku: `SKU-${Math.random().toString(36).slice(2, 10)}`,
      name: 'Test Product',
      category: 'Footwear',
      basePrice: 100,
      stockQuantity: 10,
      ...overrides,
    });
  expect(res.status).toBe(201);
  return res.body;
}

async function createPromotion(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await request(server)
    .post('/promotions')
    .send({ ...activeWindow, ...body });
  expect(res.status).toBe(201);
  return res.body;
}

async function productEffectivePrice(id: string): Promise<number> {
  const res = await request(server).get(`/products/${id}`);
  expect(res.status).toBe(200);
  return res.body.effectivePrice as number;
}

async function waitForJob(jobId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const res = await request(server).get(`/ingest/${jobId}`);
    const job = res.body as Record<string, unknown>;
    if (job?.status !== 'PROCESSING') {
      return job;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('job did not finish in time');
}

describe('products API', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates a product with base effective price', async () => {
    const res = await request(server).post('/products').send({
      sku: 'A-1',
      name: 'Shoe',
      category: 'Footwear',
      basePrice: 100,
      stockQuantity: 5,
    });
    expect(res.status).toBe(201);
    expect(res.body.effectivePrice).toBe(100);
  });

  it('rejects a duplicate sku', async () => {
    await request(server)
      .post('/products')
      .send({ sku: 'A-1', name: 'Shoe', category: 'Footwear', basePrice: 100 });
    const res = await request(server)
      .post('/products')
      .send({ sku: 'A-1', name: 'Shoe 2', category: 'Footwear', basePrice: 90 });
    expect(res.status).toBe(409);
  });

  it('lists products with category filter, pagination and sorting by effective price', async () => {
    await createProduct({ sku: 'B-1', category: 'Accessories', basePrice: 50 });
    await createProduct({ sku: 'B-2', category: 'Accessories', basePrice: 150 });
    await createProduct({ sku: 'B-3', category: 'Accessories', basePrice: 100 });
    await createProduct({ sku: 'B-4', category: 'Footwear', basePrice: 999 });

    const res = await request(server).get(
      '/products?category=Accessories&sort=price_desc&page=1&limit=2',
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination.total).toBe(3);
    expect(res.body.pagination.totalPages).toBe(2);
    expect(res.body.data[0].effectivePrice).toBe(150);
    expect(res.body.data[1].effectivePrice).toBe(100);
  });

  it('returns a single product', async () => {
    const created = await createProduct({ sku: 'C-1' });
    const res = await request(server).get(`/products/${created.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.id);
  });

  it('returns 404 for a missing product', async () => {
    const res = await request(server).get('/products/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('returns 404 for a malformed product id', async () => {
    const res = await request(server).get('/products/not-a-uuid');
    expect(res.status).toBe(404);
  });

  it('rejects an out-of-range base price', async () => {
    const res = await request(server).post('/products').send({
      sku: 'BIG-1',
      name: 'Expensive',
      category: 'Footwear',
      basePrice: 1e10,
      stockQuantity: 1,
    });
    expect(res.status).toBe(400);
  });

  it('rejects an out-of-range stock quantity', async () => {
    const res = await request(server).post('/products').send({
      sku: 'BIG-2',
      name: 'Big stock',
      category: 'Footwear',
      basePrice: 10,
      stockQuantity: 2147483648,
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for a malformed JSON body', async () => {
    const res = await request(server)
      .post('/products')
      .set('Content-Type', 'application/json')
      .send('{not json');
    expect(res.status).toBe(400);
  });

  it('does not confuse a category named * with the unfiltered listing', async () => {
    await createProduct({ sku: 'STAR-1', category: '*', basePrice: 10 });
    await createProduct({ sku: 'STAR-2', category: 'Footwear', basePrice: 20 });

    const all = await request(server).get('/products');
    expect(all.body.pagination.total).toBe(2);

    const filtered = await request(server).get('/products?category=*');
    expect(filtered.body.pagination.total).toBe(1);
    expect(filtered.body.data[0].sku).toBe('STAR-1');
  });

  it('updates the base price and recomputes the effective price', async () => {
    const created = await createProduct({ sku: 'D-1', basePrice: 100 });
    const res = await request(server).patch(`/products/${created.id}`).send({ basePrice: 50 });
    expect(res.status).toBe(200);
    expect(res.body.effectivePrice).toBe(50);
  });
});

describe('promotions API', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('creates a product promotion and updates the effective price', async () => {
    const product = await createProduct({ sku: 'E-1', basePrice: 100 });
    await createPromotion({
      name: '20% off',
      discountType: 'PERCENTAGE',
      value: 20,
      scope: 'PRODUCT',
      productId: product.id,
    });
    expect(await productEffectivePrice(product.id as string)).toBe(80);
  });

  it('rejects an overlapping product promotion', async () => {
    const product = await createProduct({ sku: 'F-1' });
    await createPromotion({
      name: 'Promo 1',
      discountType: 'PERCENTAGE',
      value: 10,
      scope: 'PRODUCT',
      productId: product.id,
    });
    const res = await request(server)
      .post('/promotions')
      .send({
        ...activeWindow,
        name: 'Promo 2',
        discountType: 'PERCENTAGE',
        value: 20,
        scope: 'PRODUCT',
        productId: product.id,
      });
    expect(res.status).toBe(409);
  });

  it('applies a category flash sale to all products in the category', async () => {
    const p1 = await createProduct({ sku: 'G-1', category: 'Accessories', basePrice: 100 });
    const p2 = await createProduct({ sku: 'G-2', category: 'Accessories', basePrice: 200 });
    const p3 = await createProduct({ sku: 'G-3', category: 'Footwear', basePrice: 50 });

    await createPromotion({
      name: '50% All Accessories',
      discountType: 'PERCENTAGE',
      value: 50,
      scope: 'CATEGORY',
      category: 'Accessories',
    });

    expect(await productEffectivePrice(p1.id as string)).toBe(50);
    expect(await productEffectivePrice(p2.id as string)).toBe(100);
    expect(await productEffectivePrice(p3.id as string)).toBe(50);
  });

  it('automatically discounts a new product added during a flash sale', async () => {
    await createPromotion({
      name: '50% All Accessories',
      discountType: 'PERCENTAGE',
      value: 50,
      scope: 'CATEGORY',
      category: 'Accessories',
    });
    const res = await request(server).post('/products').send({
      sku: 'H-1',
      name: 'New Belt',
      category: 'Accessories',
      basePrice: 40,
      stockQuantity: 1,
    });
    expect(res.status).toBe(201);
    expect(res.body.effectivePrice).toBe(20);
  });

  it('gives the product promotion precedence over the category promotion', async () => {
    const product = await createProduct({ sku: 'I-1', category: 'Accessories', basePrice: 100 });
    await createPromotion({
      name: 'Flash',
      discountType: 'PERCENTAGE',
      value: 50,
      scope: 'CATEGORY',
      category: 'Accessories',
    });
    await createPromotion({
      name: 'Product fixed',
      discountType: 'FIXED_AMOUNT',
      value: 20,
      scope: 'PRODUCT',
      productId: product.id,
    });
    expect(await productEffectivePrice(product.id as string)).toBe(80);
  });

  it('rejects an overlapping category promotion on the same category', async () => {
    await createPromotion({
      name: 'Flash 1',
      discountType: 'PERCENTAGE',
      value: 50,
      scope: 'CATEGORY',
      category: 'Accessories',
    });
    const res = await request(server)
      .post('/promotions')
      .send({
        ...activeWindow,
        name: 'Flash 2',
        discountType: 'PERCENTAGE',
        value: 30,
        scope: 'CATEGORY',
        category: 'Accessories',
      });
    expect(res.status).toBe(409);
  });

  it('cancelling a promotion restores the effective price', async () => {
    const product = await createProduct({ sku: 'J-1', basePrice: 100 });
    const promotion = await createPromotion({
      name: '20% off',
      discountType: 'PERCENTAGE',
      value: 20,
      scope: 'PRODUCT',
      productId: product.id,
    });
    expect(await productEffectivePrice(product.id as string)).toBe(80);
    const res = await request(server).post(`/promotions/${promotion.id}/cancel`);
    expect(res.status).toBe(200);
    expect(await productEffectivePrice(product.id as string)).toBe(100);
  });

  it('assigning a promotion to another product recomputes both products', async () => {
    const p1 = await createProduct({ sku: 'K-1', basePrice: 100 });
    const p2 = await createProduct({ sku: 'K-2', basePrice: 200 });
    const promotion = await createPromotion({
      name: '20% off',
      discountType: 'PERCENTAGE',
      value: 20,
      scope: 'PRODUCT',
      productId: p1.id,
    });
    const res = await request(server).post(`/promotions/${promotion.id}/assign`).send({
      scope: 'PRODUCT',
      productId: p2.id,
    });
    expect(res.status).toBe(200);
    expect(await productEffectivePrice(p1.id as string)).toBe(100);
    expect(await productEffectivePrice(p2.id as string)).toBe(160);
  });

  it('rejects an invalid percentage value', async () => {
    const product = await createProduct({ sku: 'L-1' });
    const res = await request(server)
      .post('/promotions')
      .send({
        ...activeWindow,
        name: 'Bad',
        discountType: 'PERCENTAGE',
        value: 150,
        scope: 'PRODUCT',
        productId: product.id,
      });
    expect(res.status).toBe(400);
  });

  it('rejects productId together with a category on a PRODUCT promotion', async () => {
    const product = await createProduct({ sku: 'M-1' });
    const res = await request(server)
      .post('/promotions')
      .send({
        ...activeWindow,
        name: 'Mixed',
        discountType: 'PERCENTAGE',
        value: 10,
        scope: 'PRODUCT',
        productId: product.id,
        category: 'Accessories',
      });
    expect(res.status).toBe(400);
  });

  it('rejects productId together with a category on a CATEGORY promotion', async () => {
    const product = await createProduct({ sku: 'M-2' });
    const res = await request(server)
      .post('/promotions')
      .send({
        ...activeWindow,
        name: 'Mixed',
        discountType: 'PERCENTAGE',
        value: 10,
        scope: 'CATEGORY',
        productId: product.id,
        category: 'Accessories',
      });
    expect(res.status).toBe(400);
  });

  it('rejects assigning a cancelled promotion', async () => {
    const p1 = await createProduct({ sku: 'N-1' });
    const p2 = await createProduct({ sku: 'N-2' });
    const promotion = await createPromotion({
      name: '20% off',
      discountType: 'PERCENTAGE',
      value: 20,
      scope: 'PRODUCT',
      productId: p1.id,
    });
    await request(server).post(`/promotions/${promotion.id}/cancel`);
    const res = await request(server).post(`/promotions/${promotion.id}/assign`).send({
      scope: 'PRODUCT',
      productId: p2.id,
    });
    expect(res.status).toBe(400);
  });
});

describe('ingestion API (Scenario A)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('ingests a CSV file, computes effective prices and is idempotent', async () => {
    await createPromotion({
      name: '50% All Accessories',
      discountType: 'PERCENTAGE',
      value: 50,
      scope: 'CATEGORY',
      category: 'Accessories',
    });

    const csv = [
      'sku,name,category,basePrice,stockQuantity',
      'T-1,Thing 1,Accessories,100,10',
      'T-2,Thing 2,Footwear,200,20',
      'T-3,Thing 3,Accessories,40,5',
    ].join('\n');

    const upload = await request(server)
      .post('/ingest')
      .attach('file', Buffer.from(csv), { filename: 'products.csv', contentType: 'text/csv' });
    expect(upload.status).toBe(202);
    const jobId = upload.body.jobId as string;

    const job = await waitForJob(jobId);
    expect(job.status).toBe('COMPLETED');
    expect(job.totalRecords).toBe(3);
    expect(job.skippedRecords).toBe(0);

    const accessory = await prisma.product.findUnique({ where: { sku: 'T-1' } });
    const footwear = await prisma.product.findUnique({ where: { sku: 'T-2' } });
    expect(Number(accessory?.effectivePrice)).toBe(50);
    expect(Number(footwear?.effectivePrice)).toBe(200);

    const total = await prisma.product.count();
    expect(total).toBe(3);

    const rerun = await request(server)
      .post('/ingest')
      .attach('file', Buffer.from(csv), { filename: 'products.csv', contentType: 'text/csv' });
    expect(rerun.status).toBe(202);
    const rerunJob = await waitForJob(rerun.body.jobId as string);
    expect(rerunJob.status).toBe('COMPLETED');
    expect(await prisma.product.count()).toBe(3);
  });

  it('completes the job and reports rows skipped for malformed rows', async () => {
    const csv = [
      'sku,name,category,basePrice,stockQuantity',
      'S-1,Good,Accessories,100,10',
      'bad,row',
      'S-2,Also good,Footwear,200,20',
    ].join('\n');

    const upload = await request(server)
      .post('/ingest')
      .attach('file', Buffer.from(csv), { filename: 'skipped.csv', contentType: 'text/csv' });
    expect(upload.status).toBe(202);

    const job = await waitForJob(upload.body.jobId as string);
    expect(job.status).toBe('COMPLETED');
    expect(job.totalRecords).toBe(3);
    expect(job.processedRecords).toBe(2);
    expect(job.skippedRecords).toBe(1);
  });

  it('deletes the uploaded file after the pipeline completes', async () => {
    const uploadsDir = join(process.cwd(), env.UPLOAD_DIR);
    const list = async (): Promise<string[]> =>
      (await fsp.readdir(uploadsDir).catch(() => [])).sort();
    const before = await list();

    const csv = ['sku,name,category,basePrice,stockQuantity', 'C-1,Thing,Footwear,10,5'].join('\n');
    const upload = await request(server)
      .post('/ingest')
      .attach('file', Buffer.from(csv), { filename: 'cleanup.csv', contentType: 'text/csv' });
    expect(upload.status).toBe(202);

    const job = await waitForJob(upload.body.jobId as string);
    expect(job.status).toBe('COMPLETED');

    let after = await list();
    for (let i = 0; i < 100 && after.length !== before.length; i++) {
      await new Promise((r) => setTimeout(r, 50));
      after = await list();
    }
    expect(after).toEqual(before);
  });
});
