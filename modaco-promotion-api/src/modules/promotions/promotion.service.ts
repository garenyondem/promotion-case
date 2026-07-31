import { errors } from '../../shared/errors';
import type { CacheService } from '../../cache';
import type { DiscountType, PromotionScope } from '../../shared/pricing/types';
import { recomputeCategory, recomputeProduct } from '../../services/recompute.service';
import { toPromotionDto, type PromotionDto } from './promotion.dto';
import { PromotionRepository } from './promotion.repository';

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

export interface AssignPromotionInput {
  scope?: PromotionScope;
  productId?: string | null;
  category?: string | null;
}

export class PromotionService {
  constructor(
    private readonly promotions: PromotionRepository,
    private readonly cache: CacheService,
    private readonly productExists: (id: string) => Promise<boolean>,
  ) {}

  private validate(input: CreatePromotionInput): void {
    if (input.endAt <= input.startAt) {
      throw errors.badRequest('endAt must be after startAt');
    }
    if (input.discountType === 'PERCENTAGE' && (input.value <= 0 || input.value > 100)) {
      throw errors.badRequest('Percentage value must be greater than 0 and at most 100');
    }
    if (input.discountType === 'FIXED_AMOUNT' && input.value <= 0) {
      throw errors.badRequest('Fixed amount value must be positive');
    }
    if (input.scope === 'PRODUCT' && !input.productId) {
      throw errors.badRequest('productId is required for PRODUCT scope');
    }
    if (input.scope === 'CATEGORY' && !input.category) {
      throw errors.badRequest('category is required for CATEGORY scope');
    }
  }

  async create(input: CreatePromotionInput): Promise<PromotionDto> {
    this.validate(input);
    if (input.scope === 'PRODUCT') {
      const productId = input.productId as string;
      if (!(await this.productExists(productId))) {
        throw errors.notFound('Product not found');
      }
      const overlapping = await this.promotions.findOverlappingProductPromo(productId, input.startAt, input.endAt);
      if (overlapping) {
        throw errors.conflict('The product already has an active promotion in that period');
      }
    } else {
      const category = input.category as string;
      const overlapping = await this.promotions.findOverlappingCategoryPromo(category, input.startAt, input.endAt);
      if (overlapping) {
        throw errors.conflict('The category already has an active promotion in that period');
      }
    }
    const promotion = await this.promotions.create(input);
    if (input.scope === 'PRODUCT') {
      await recomputeProduct(input.productId as string);
    } else {
      await recomputeCategory(input.category as string);
    }
    await this.cache.bumpGeneration();
    return toPromotionDto(promotion);
  }

  async cancel(id: string): Promise<PromotionDto> {
    const promotion = await this.promotions.findById(id);
    if (!promotion) {
      throw errors.notFound('Promotion not found');
    }
    if (promotion.status === 'CANCELLED') {
      return toPromotionDto(promotion);
    }
    const updated = await this.promotions.update(id, { status: 'CANCELLED' });
    if (promotion.scope === 'PRODUCT' && promotion.productId) {
      await recomputeProduct(promotion.productId);
    } else if (promotion.scope === 'CATEGORY' && promotion.category) {
      await recomputeCategory(promotion.category);
    }
    await this.cache.bumpGeneration();
    return toPromotionDto(updated);
  }

  async assign(id: string, input: AssignPromotionInput): Promise<PromotionDto> {
    const promotion = await this.promotions.findById(id);
    if (!promotion) {
      throw errors.notFound('Promotion not found');
    }
    const scope = input.scope ?? promotion.scope;
    const productId = scope === 'PRODUCT' ? (input.productId ?? promotion.productId) : null;
    const category = scope === 'CATEGORY' ? (input.category ?? promotion.category) : null;
    if (scope === 'PRODUCT' && !productId) {
      throw errors.badRequest('productId is required for PRODUCT scope');
    }
    if (scope === 'CATEGORY' && !category) {
      throw errors.badRequest('category is required for CATEGORY scope');
    }
    if (scope === 'PRODUCT') {
      const targetProductId = productId as string;
      if (!(await this.productExists(targetProductId))) {
        throw errors.notFound('Product not found');
      }
      const overlapping = await this.promotions.findOverlappingProductPromo(
        targetProductId,
        promotion.startAt,
        promotion.endAt,
        promotion.id,
      );
      if (overlapping) {
        throw errors.conflict('The product already has an active promotion in that period');
      }
    } else {
      const targetCategory = category as string;
      const overlapping = await this.promotions.findOverlappingCategoryPromo(
        targetCategory,
        promotion.startAt,
        promotion.endAt,
        promotion.id,
      );
      if (overlapping) {
        throw errors.conflict('The category already has an active promotion in that period');
      }
    }
    const updated = await this.promotions.update(id, { scope, productId, category });
    if (promotion.scope === 'PRODUCT' && promotion.productId) {
      await recomputeProduct(promotion.productId);
    } else if (promotion.scope === 'CATEGORY' && promotion.category) {
      await recomputeCategory(promotion.category);
    }
    if (scope === 'PRODUCT') {
      await recomputeProduct(productId as string);
    } else {
      await recomputeCategory(category as string);
    }
    await this.cache.bumpGeneration();
    return toPromotionDto(updated);
  }

  async list(): Promise<PromotionDto[]> {
    return (await this.promotions.list()).map(toPromotionDto);
  }
}
