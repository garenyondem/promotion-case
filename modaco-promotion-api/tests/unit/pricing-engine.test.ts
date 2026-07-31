import { describe, expect, it } from 'vitest';
import {
  computeEffectivePrice,
  resolveEffectivePromotion,
} from '../../src/shared/pricing/pricing-engine';
import type { PriceProduct, PricePromotion } from '../../src/shared/pricing/types';

const product: PriceProduct = { id: 'p1', sku: 'SKU-1', category: 'Accessories', basePrice: 100 };

const categoryPromo: PricePromotion = {
  id: 'cat',
  discountType: 'PERCENTAGE',
  value: 50,
  scope: 'CATEGORY',
  category: 'Accessories',
};

const productPromo: PricePromotion = {
  id: 'prod',
  discountType: 'FIXED_AMOUNT',
  value: 20,
  scope: 'PRODUCT',
  productId: 'p1',
};

describe('pricing engine', () => {
  it('returns the base price when no promotion applies', () => {
    expect(computeEffectivePrice(product, []).effectivePrice).toBe(100);
  });

  it('applies a percentage discount', () => {
    expect(computeEffectivePrice(product, [categoryPromo]).effectivePrice).toBe(50);
  });

  it('applies a fixed amount discount', () => {
    expect(computeEffectivePrice(product, [productPromo]).effectivePrice).toBe(80);
  });

  it('floors the fixed amount discount at zero', () => {
    const big = { ...productPromo, value: 500 };
    expect(computeEffectivePrice(product, [big]).effectivePrice).toBe(0);
  });

  it('rounds to two decimals', () => {
    const p = { ...categoryPromo, value: 33.33 };
    expect(computeEffectivePrice(product, [p]).effectivePrice).toBe(66.67);
  });

  it('rounds half-cents correctly for money (136.325 to 136.33)', () => {
    const half = { ...categoryPromo, value: 50 };
    const result = computeEffectivePrice({ ...product, basePrice: 272.65 }, [half]);
    expect(result.effectivePrice).toBe(136.33);
  });

  it('gives the product-specific promotion precedence over the category promotion', () => {
    const result = computeEffectivePrice(product, [categoryPromo, productPromo]);
    expect(result.appliedPromotionId).toBe('prod');
    expect(result.effectivePrice).toBe(80);
  });

  it('applies the category promotion when no product promotion exists', () => {
    const result = computeEffectivePrice(product, [categoryPromo]);
    expect(result.appliedPromotionId).toBe('cat');
    expect(result.effectivePrice).toBe(50);
  });

  it('resolve prefers the product scope', () => {
    expect(resolveEffectivePromotion(product, [categoryPromo, productPromo])?.id).toBe('prod');
  });

  it('does not match a category promotion of another category', () => {
    const other = { ...categoryPromo, category: 'Footwear' };
    expect(resolveEffectivePromotion(product, [other])).toBeNull();
  });
});
