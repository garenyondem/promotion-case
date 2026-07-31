import type { Prisma, Promotion } from '@prisma/client';
import { prisma } from '../db/client';
import { computeEffectivePrice } from '../shared/pricing/pricing-engine';
import type { PricePromotion } from '../shared/pricing/types';

function toPricePromotion(p: Promotion): PricePromotion {
  return {
    id: p.id,
    discountType: p.discountType,
    value: Number(p.value),
    scope: p.scope,
    productId: p.productId,
    category: p.category,
  };
}

async function activePromotions(where: Prisma.PromotionWhereInput): Promise<PricePromotion[]> {
  const now = new Date();
  const rows = await prisma.promotion.findMany({
    where: { status: 'ACTIVE', startAt: { lte: now }, endAt: { gte: now }, ...where },
  });
  return rows.map(toPricePromotion);
}

export async function recomputeProduct(productId: string): Promise<void> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) {
    return;
  }
  const promos = await activePromotions({
    OR: [
      { scope: 'PRODUCT', productId },
      { scope: 'CATEGORY', category: product.category },
    ],
  });
  const result = computeEffectivePrice(
    {
      id: product.id,
      sku: product.sku,
      category: product.category,
      basePrice: Number(product.basePrice),
    },
    promos,
  );
  await prisma.product.update({
    where: { id: productId },
    data: { effectivePrice: result.effectivePrice },
  });
}

export async function recomputeCategory(category: string): Promise<void> {
  const batchSize = 2000;
  let cursor: string | null = null;
  for (;;) {
    const args: Prisma.ProductFindManyArgs = {
      where: { category },
      orderBy: { id: 'asc' },
      take: batchSize,
      select: { id: true, sku: true, category: true, basePrice: true },
    };
    if (cursor) {
      args.cursor = { id: cursor };
      args.skip = 1;
    }
    const products = await prisma.product.findMany(args);
    if (products.length === 0) {
      break;
    }
    cursor = products[products.length - 1].id;
    const promos = await activePromotions({
      OR: [
        { scope: 'PRODUCT', productId: { in: products.map((p) => p.id) } },
        { scope: 'CATEGORY', category },
      ],
    });
    const productPromos = new Map<string, PricePromotion[]>();
    for (const promo of promos) {
      if (promo.scope === 'PRODUCT' && promo.productId) {
        const list = productPromos.get(promo.productId) ?? [];
        list.push(promo);
        productPromos.set(promo.productId, list);
      }
    }
    const categoryPromos = promos.filter((p) => p.scope === 'CATEGORY');
    const updates: Array<{ id: string; price: number }> = [];
    for (const product of products) {
      const covering = [...(productPromos.get(product.id) ?? []), ...categoryPromos];
      const result = computeEffectivePrice(
        { id: product.id, sku: product.sku, category, basePrice: Number(product.basePrice) },
        covering,
      );
      updates.push({ id: product.id, price: result.effectivePrice });
    }
    await bulkUpdateEffectivePrices(updates);
    if (products.length < batchSize) {
      break;
    }
  }
}

async function bulkUpdateEffectivePrices(
  updates: Array<{ id: string; price: number }>,
): Promise<void> {
  if (updates.length === 0) {
    return;
  }
  const placeholders: string[] = [];
  const values: unknown[] = [];
  updates.forEach((u, i) => {
    const base = i * 2;
    placeholders.push(`($${base + 1}::uuid,$${base + 2}::numeric)`);
    values.push(u.id, u.price);
  });
  const sql = `UPDATE "products" SET "effectivePrice" = data.price
FROM (VALUES ${placeholders.join(',')}) AS data(id, price)
WHERE "products"."id" = data.id`;
  await prisma.$executeRawUnsafe(sql, ...values);
}
