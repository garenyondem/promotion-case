import { PrismaClient } from '@prisma/client';
import { computeEffectivePrice } from '../src/shared/pricing/pricing-engine';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  await prisma.product.deleteMany();
  await prisma.promotion.deleteMany();
  await prisma.ingestionJob.deleteMany();

  const products = [
    {
      sku: 'SKU-ACC-001',
      name: 'Leather Belt',
      category: 'Accessories',
      basePrice: 39.99,
      stockQuantity: 100,
    },
    {
      sku: 'SKU-ACC-002',
      name: 'Canvas Tote',
      category: 'Accessories',
      basePrice: 59.99,
      stockQuantity: 50,
    },
    {
      sku: 'SKU-ACC-003',
      name: 'Wool Scarf',
      category: 'Accessories',
      basePrice: 29.99,
      stockQuantity: 80,
    },
    {
      sku: 'SKU-FTW-001',
      name: 'Running Shoe',
      category: 'Footwear',
      basePrice: 89.99,
      stockQuantity: 200,
    },
    {
      sku: 'SKU-APP-001',
      name: 'Cotton Tee',
      category: 'Apparel',
      basePrice: 19.99,
      stockQuantity: 150,
    },
  ];
  for (const product of products) {
    await prisma.product.create({ data: { ...product, effectivePrice: product.basePrice } });
  }

  await prisma.promotion.create({
    data: {
      name: 'Spring Accessories 20%',
      discountType: 'PERCENTAGE',
      value: 20,
      startAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      endAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      scope: 'CATEGORY',
      category: 'Accessories',
    },
  });

  const promotions = await prisma.promotion.findMany({
    where: { status: 'ACTIVE', scope: 'CATEGORY', category: 'Accessories' },
  });
  const accProducts = await prisma.product.findMany({ where: { category: 'Accessories' } });
  const pricePromotions = promotions.map((p) => ({
    id: p.id,
    discountType: p.discountType,
    value: Number(p.value),
    scope: p.scope,
    productId: p.productId,
    category: p.category,
  }));
  for (const product of accProducts) {
    const result = computeEffectivePrice(
      {
        id: product.id,
        sku: product.sku,
        category: product.category,
        basePrice: Number(product.basePrice),
      },
      pricePromotions,
    );
    await prisma.product.update({
      where: { id: product.id },
      data: { effectivePrice: result.effectivePrice },
    });
  }

  console.log('seed complete');
}

void main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
