import { DEFAULT_RULES, type PricingContext, type PricingRule } from './rules';
import type { PriceProduct, PricePromotion, PricingResult } from './types';

export function resolveEffectivePromotion(
  product: PriceProduct,
  promotions: PricePromotion[],
): PricePromotion | null {
  const covering = promotions.filter((p) => {
    if (p.scope === 'PRODUCT') {
      return p.productId === product.id;
    }
    return p.category === product.category;
  });
  return (
    covering.find((p) => p.scope === 'PRODUCT') ??
    covering.find((p) => p.scope === 'CATEGORY') ??
    null
  );
}

export function computeEffectivePrice(
  product: PriceProduct,
  promotions: PricePromotion[],
  rules: PricingRule[] = DEFAULT_RULES,
): PricingResult {
  const winner = resolveEffectivePromotion(product, promotions);
  let ctx: PricingContext = {
    basePrice: product.basePrice,
    discountType: winner ? winner.discountType : null,
    value: winner ? winner.value : null,
    effectivePrice: product.basePrice,
  };
  for (const rule of rules) {
    ctx = rule(ctx);
  }
  return { effectivePrice: ctx.effectivePrice, appliedPromotionId: winner ? winner.id : null };
}
