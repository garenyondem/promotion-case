import type { Product } from '@prisma/client';

export interface ProductDto {
  id: string;
  sku: string;
  name: string;
  category: string;
  basePrice: number;
  effectivePrice: number;
  stockQuantity: number;
  createdAt: string;
  updatedAt: string;
}

export function toProductDto(product: Product): ProductDto {
  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    category: product.category,
    basePrice: Number(product.basePrice),
    effectivePrice: Number(product.effectivePrice),
    stockQuantity: product.stockQuantity,
    createdAt: product.createdAt.toISOString(),
    updatedAt: product.updatedAt.toISOString(),
  };
}
