export const DISCOUNT_TYPE_PERCENTAGE = 'PERCENTAGE';
export const DISCOUNT_TYPE_FIXED_AMOUNT = 'FIXED_AMOUNT';
export const PROMOTION_SCOPE_PRODUCT = 'PRODUCT';
export const PROMOTION_SCOPE_CATEGORY = 'CATEGORY';

export type DiscountType = 'PERCENTAGE' | 'FIXED_AMOUNT';
export type PromotionScope = 'PRODUCT' | 'CATEGORY';

export interface PricePromotion {
  id: string;
  discountType: DiscountType;
  value: number;
  scope: PromotionScope;
  productId?: string | null;
  category?: string | null;
}

export interface PriceProduct {
  id?: string | null;
  sku: string;
  category: string;
  basePrice: number;
}

export interface PricingResult {
  effectivePrice: number;
  appliedPromotionId: string | null;
}
