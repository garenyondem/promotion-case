import type { DiscountType } from './types';

export interface PricingContext {
  basePrice: number;
  discountType: DiscountType | null;
  value: number | null;
  effectivePrice: number;
}

export type PricingRule = (ctx: PricingContext) => PricingContext;

function toCents(amount: number): number {
  return Math.round(amount * 100);
}

function toDollars(cents: number): number {
  return cents / 100;
}

export function discountRule(ctx: PricingContext): PricingContext {
  if (ctx.discountType === null || ctx.value === null) {
    return ctx;
  }
  const baseCents = toCents(ctx.basePrice);
  let cents: number;
  if (ctx.discountType === 'PERCENTAGE') {
    cents = Math.round((baseCents * (100 - ctx.value)) / 100);
  } else {
    cents = baseCents - toCents(ctx.value);
  }
  return { ...ctx, effectivePrice: toDollars(Math.max(0, cents)) };
}

export function minimumPriceRule(min: number): PricingRule {
  return (ctx) => {
    const cents = Math.max(toCents(min), toCents(ctx.effectivePrice));
    return { ...ctx, effectivePrice: toDollars(cents) };
  };
}

export const DEFAULT_RULES: PricingRule[] = [discountRule];
