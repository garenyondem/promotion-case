import type { Promotion } from '@prisma/client';
import { prisma } from '../../db/client';
import type { DiscountType, PromotionScope } from '../../shared/pricing/types';

export interface CreatePromotionInput {
  name: string;
  discountType: DiscountType;
  value: number;
  startAt: Date;
  endAt: Date;
  scope: PromotionScope;
  productId?: string | null;
  category?: string | null;
}

export class PromotionRepository {
  findById(id: string): Promise<Promotion | null> {
    return prisma.promotion.findUnique({ where: { id } });
  }

  list(): Promise<Promotion[]> {
    return prisma.promotion.findMany({ orderBy: { createdAt: 'desc' } });
  }

  create(data: CreatePromotionInput): Promise<Promotion> {
    return prisma.promotion.create({ data: { ...data, status: 'ACTIVE' } });
  }

  update(id: string, data: Partial<Promotion>): Promise<Promotion> {
    return prisma.promotion.update({ where: { id }, data });
  }

  findOverlappingProductPromo(productId: string, startAt: Date, endAt: Date, excludeId?: string): Promise<Promotion | null> {
    return prisma.promotion.findFirst({
      where: {
        status: 'ACTIVE',
        scope: 'PRODUCT',
        productId,
        startAt: { lte: endAt },
        endAt: { gte: startAt },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
  }

  findOverlappingCategoryPromo(category: string, startAt: Date, endAt: Date, excludeId?: string): Promise<Promotion | null> {
    return prisma.promotion.findFirst({
      where: {
        status: 'ACTIVE',
        scope: 'CATEGORY',
        category,
        startAt: { lte: endAt },
        endAt: { gte: startAt },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
  }

  findActiveCategoryPromos(category: string): Promise<Promotion[]> {
    const now = new Date();
    return prisma.promotion.findMany({
      where: { status: 'ACTIVE', scope: 'CATEGORY', category, startAt: { lte: now }, endAt: { gte: now } },
    });
  }

  findActiveCovering(productId: string, category: string): Promise<Promotion[]> {
    const now = new Date();
    return prisma.promotion.findMany({
      where: {
        status: 'ACTIVE',
        startAt: { lte: now },
        endAt: { gte: now },
        OR: [{ scope: 'PRODUCT', productId }, { scope: 'CATEGORY', category }],
      },
    });
  }
}
