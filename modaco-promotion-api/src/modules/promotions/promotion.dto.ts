import type { Promotion } from '@prisma/client';

export interface PromotionDto {
  id: string;
  name: string;
  discountType: string;
  value: number;
  startAt: string;
  endAt: string;
  status: string;
  scope: string;
  productId: string | null;
  category: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toPromotionDto(promotion: Promotion): PromotionDto {
  return {
    id: promotion.id,
    name: promotion.name,
    discountType: promotion.discountType,
    value: Number(promotion.value),
    startAt: promotion.startAt.toISOString(),
    endAt: promotion.endAt.toISOString(),
    status: promotion.status,
    scope: promotion.scope,
    productId: promotion.productId,
    category: promotion.category,
    createdAt: promotion.createdAt.toISOString(),
    updatedAt: promotion.updatedAt.toISOString(),
  };
}
