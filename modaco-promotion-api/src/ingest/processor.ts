import { randomUUID } from 'node:crypto';
import { prisma } from '../db/client';
import { computeEffectivePrice } from '../shared/pricing/pricing-engine';
import type { PricePromotion } from '../shared/pricing/types';
import { incrementProcessed } from './jobs';

export interface IngestRow {
  sku: string;
  name: string;
  category: string;
  basePrice: number;
  stockQuantity: number;
}

export interface ChunkMessage {
  jobId: string;
  rows: string[][];
}

export function parseRow(raw: string[]): IngestRow | null {
  if (raw.length < 5) {
    return null;
  }
  const [sku, name, category, basePriceRaw, stockRaw] = raw.map((v) => (v ?? '').trim());
  const basePrice = Number(basePriceRaw);
  const stockQuantity = Number(stockRaw);
  if (!sku || !name || !category) {
    return null;
  }
  if (!Number.isFinite(basePrice) || basePrice < 0) {
    return null;
  }
  if (!Number.isInteger(stockQuantity) || stockQuantity < 0) {
    return null;
  }
  return { sku, name, category, basePrice, stockQuantity };
}

export async function processChunk(message: ChunkMessage): Promise<{ upserted: number; skipped: number }> {
  const { jobId, rows } = message;
  const parsed = rows.map(parseRow);
  const valid = parsed.filter((r): r is IngestRow => r !== null);
  const skipped = parsed.length - valid.length;

  if (valid.length === 0) {
    await incrementProcessed(jobId, 0, skipped);
    return { upserted: 0, skipped };
  }

  const categories = [...new Set(valid.map((r) => r.category))];
  const categoryPromos = await prisma.promotion.findMany({
    where: {
      status: 'ACTIVE',
      scope: 'CATEGORY',
      category: { in: categories },
      startAt: { lte: new Date() },
      endAt: { gte: new Date() },
    },
  });
  const categoryMap = new Map<string, PricePromotion[]>();
  for (const promo of categoryPromos) {
    if (!promo.category) {
      continue;
    }
    const list = categoryMap.get(promo.category) ?? [];
    list.push({ id: promo.id, discountType: promo.discountType, value: Number(promo.value), scope: promo.scope, productId: promo.productId, category: promo.category });
    categoryMap.set(promo.category, list);
  }

  const skus = valid.map((r) => r.sku);
  const existing = await prisma.product.findMany({ where: { sku: { in: skus } }, select: { id: true, sku: true } });
  const existingIdBySku = new Map(existing.map((p) => [p.sku, p.id]));
  const existingIds = existing.map((p) => p.id);
  const productPromos =
    existingIds.length > 0
      ? await prisma.promotion.findMany({
          where: {
            status: 'ACTIVE',
            scope: 'PRODUCT',
            productId: { in: existingIds },
            startAt: { lte: new Date() },
            endAt: { gte: new Date() },
          },
        })
      : [];
  const productPromoMap = new Map<string, PricePromotion[]>();
  for (const promo of productPromos) {
    if (!promo.productId) {
      continue;
    }
    const list = productPromoMap.get(promo.productId) ?? [];
    list.push({ id: promo.id, discountType: promo.discountType, value: Number(promo.value), scope: promo.scope, productId: promo.productId, category: promo.category });
    productPromoMap.set(promo.productId, list);
  }

  const now = new Date();
  const prepared = valid.map((row) => {
    const productId = existingIdBySku.get(row.sku) ?? null;
    const covering: PricePromotion[] = [
      ...(productId ? productPromoMap.get(productId) ?? [] : []),
      ...(categoryMap.get(row.category) ?? []),
    ];
    const result = computeEffectivePrice(
      { id: productId, sku: row.sku, category: row.category, basePrice: row.basePrice },
      covering,
    );
    return {
      id: productId ?? randomUUID(),
      sku: row.sku,
      name: row.name,
      category: row.category,
      basePrice: row.basePrice,
      effectivePrice: result.effectivePrice,
      stockQuantity: row.stockQuantity,
      createdAt: now,
      updatedAt: now,
    };
  });

  await bulkUpsertProducts(prepared);
  await incrementProcessed(jobId, valid.length, skipped);
  return { upserted: valid.length, skipped };
}

interface PreparedProduct {
  id: string;
  sku: string;
  name: string;
  category: string;
  basePrice: number;
  effectivePrice: number;
  stockQuantity: number;
  createdAt: Date;
  updatedAt: Date;
}

async function bulkUpsertProducts(rows: PreparedProduct[]): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const fieldCount = 9;
  const placeholders: string[] = [];
  const values: unknown[] = [];
  rows.forEach((row, i) => {
    const base = i * fieldCount;
    placeholders.push(
      `($${base + 1}::uuid,$${base + 2},$${base + 3},$${base + 4},$${base + 5}::numeric,$${base + 6}::numeric,$${base + 7},$${base + 8},$${base + 9})`,
    );
    values.push(row.id, row.sku, row.name, row.category, row.basePrice, row.effectivePrice, row.stockQuantity, row.createdAt, row.updatedAt);
  });
  const sql = `INSERT INTO "products" ("id","sku","name","category","basePrice","effectivePrice","stockQuantity","createdAt","updatedAt")
VALUES ${placeholders.join(',')}
ON CONFLICT ("sku") DO UPDATE SET
  "name" = EXCLUDED."name",
  "category" = EXCLUDED."category",
  "basePrice" = EXCLUDED."basePrice",
  "effectivePrice" = EXCLUDED."effectivePrice",
  "stockQuantity" = EXCLUDED."stockQuantity",
  "updatedAt" = EXCLUDED."updatedAt"`;
  await prisma.$executeRawUnsafe(sql, ...values);
}
