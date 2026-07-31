import type { Prisma, Product } from '@prisma/client';
import { prisma } from '../../db/client';

export type ProductSort = 'price_asc' | 'price_desc' | 'created_at';

export interface ListProductsParams {
  category?: string;
  sort: ProductSort;
  page: number;
  limit: number;
}

export class ProductRepository {
  async list(params: ListProductsParams): Promise<{ total: number; items: Product[] }> {
    const where: Prisma.ProductWhereInput = params.category ? { category: params.category } : {};
    const orderBy: Prisma.ProductOrderByWithRelationInput =
      params.sort === 'price_asc'
        ? { effectivePrice: 'asc' }
        : params.sort === 'price_desc'
          ? { effectivePrice: 'desc' }
          : { createdAt: 'desc' };
    const [total, items] = await prisma.$transaction([
      prisma.product.count({ where }),
      prisma.product.findMany({ where, orderBy, skip: (params.page - 1) * params.limit, take: params.limit }),
    ]);
    return { total, items };
  }

  findById(id: string): Promise<Product | null> {
    return prisma.product.findUnique({ where: { id } });
  }

  findBySku(sku: string): Promise<Product | null> {
    return prisma.product.findUnique({ where: { sku } });
  }

  create(data: Prisma.ProductUncheckedCreateInput): Promise<Product> {
    return prisma.product.create({ data });
  }

  update(id: string, data: Prisma.ProductUncheckedUpdateInput): Promise<Product> {
    return prisma.product.update({ where: { id }, data });
  }
}
