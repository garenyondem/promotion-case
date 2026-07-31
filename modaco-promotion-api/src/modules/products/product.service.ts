import { Prisma } from '@prisma/client';
import { computeEffectivePrice } from '../../shared/pricing/pricing-engine';
import { errors } from '../../shared/errors';
import type { CacheService } from '../../cache';
import type { PromotionRepository } from '../promotions/promotion.repository';
import { toProductDto, type ProductDto } from './product.dto';
import { ProductRepository, type ListProductsParams, type ProductSort } from './product.repository';

export interface CreateProductInput {
  sku: string;
  name: string;
  category: string;
  basePrice: number;
  stockQuantity: number;
}

export interface UpdateProductInput {
  sku?: string;
  name?: string;
  category?: string;
  basePrice?: number;
  stockQuantity?: number;
}

export interface ProductListPayload {
  data: ProductDto[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export class ProductService {
  constructor(
    private readonly products: ProductRepository,
    private readonly promotions: PromotionRepository,
    private readonly cache: CacheService,
  ) {}

  async list(params: ListProductsParams): Promise<ProductListPayload> {
    const key = await this.cache.listingKey(
      params.category,
      params.sort,
      params.page,
      params.limit,
    );
    const cached = await this.cache.getListing(key);
    if (cached) {
      return cached as unknown as ProductListPayload;
    }
    const { total, items } = await this.products.list(params);
    const payload: ProductListPayload = {
      data: items.map(toProductDto),
      pagination: {
        page: params.page,
        limit: params.limit,
        total,
        totalPages: Math.ceil(total / params.limit),
      },
    };
    await this.cache.setListing(key, payload);
    return payload;
  }

  async getById(id: string): Promise<ProductDto> {
    const cached = await this.cache.getProduct(id);
    if (cached) {
      return cached as unknown as ProductDto;
    }
    const product = await this.products.findById(id);
    if (!product) {
      throw errors.notFound('Product not found');
    }
    const dto = toProductDto(product);
    await this.cache.setProduct(id, dto);
    return dto;
  }

  async create(input: CreateProductInput): Promise<ProductDto> {
    const existing = await this.products.findBySku(input.sku);
    if (existing) {
      throw errors.conflict(`Product with sku ${input.sku} already exists`);
    }
    const covering = await this.promotions.findActiveCategoryPromos(input.category);
    const result = computeEffectivePrice(
      { sku: input.sku, category: input.category, basePrice: input.basePrice },
      covering.map((p) => ({
        id: p.id,
        discountType: p.discountType,
        value: Number(p.value),
        scope: p.scope,
        productId: p.productId,
        category: p.category,
      })),
    );
    try {
      const product = await this.products.create({
        ...input,
        effectivePrice: result.effectivePrice,
      });
      await this.cache.bumpGeneration();
      return toProductDto(product);
    } catch (error) {
      if (this.isDuplicateSku(error)) {
        throw errors.conflict(`Product with sku ${input.sku} already exists`);
      }
      throw error;
    }
  }

  async update(id: string, input: UpdateProductInput): Promise<ProductDto> {
    const product = await this.products.findById(id);
    if (!product) {
      throw errors.notFound('Product not found');
    }
    if (input.sku && input.sku !== product.sku) {
      const existing = await this.products.findBySku(input.sku);
      if (existing) {
        throw errors.conflict(`Product with sku ${input.sku} already exists`);
      }
    }
    const nextCategory = input.category ?? product.category;
    const nextBasePrice = input.basePrice ?? Number(product.basePrice);
    const covering = await this.promotions.findActiveCovering(id, nextCategory);
    const result = computeEffectivePrice(
      { id, sku: input.sku ?? product.sku, category: nextCategory, basePrice: nextBasePrice },
      covering.map((p) => ({
        id: p.id,
        discountType: p.discountType,
        value: Number(p.value),
        scope: p.scope,
        productId: p.productId,
        category: p.category,
      })),
    );
    try {
      const updated = await this.products.update(id, {
        ...input,
        effectivePrice: result.effectivePrice,
      });
      await this.cache.bumpGeneration();
      return toProductDto(updated);
    } catch (error) {
      if (this.isDuplicateSku(error)) {
        throw errors.conflict(`Product with sku ${input.sku} already exists`);
      }
      throw error;
    }
  }

  private isDuplicateSku(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}

export type { ProductSort };
