import { z } from 'zod';
import type { RequestHandler } from 'express';
import type { PromotionService } from './promotion.service';

const MAX_MONEY = 9999999999.99;

const createPromotionSchema = z
  .object({
    name: z.string().min(1).max(200),
    discountType: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']),
    value: z.number().positive().max(MAX_MONEY),
    startAt: z.coerce.date(),
    endAt: z.coerce.date(),
    scope: z.enum(['PRODUCT', 'CATEGORY']),
    productId: z.string().uuid().optional(),
    category: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.scope === 'PRODUCT' && data.category !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['category'],
        message: 'category must not be set for PRODUCT scope',
      });
    }
    if (data.scope === 'CATEGORY' && data.productId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['productId'],
        message: 'productId must not be set for CATEGORY scope',
      });
    }
  });

const assignPromotionSchema = z
  .object({
    scope: z.enum(['PRODUCT', 'CATEGORY']).optional(),
    productId: z.string().uuid().optional(),
    category: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.scope === 'PRODUCT' && data.category !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['category'],
        message: 'category must not be set for PRODUCT scope',
      });
    }
    if (data.scope === 'CATEGORY' && data.productId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['productId'],
        message: 'productId must not be set for CATEGORY scope',
      });
    }
  });

export class PromotionController {
  constructor(private readonly service: PromotionService) {}

  create: RequestHandler = async (req, res, next) => {
    try {
      const body = createPromotionSchema.parse(req.body);
      res.status(201).json(await this.service.create(body));
    } catch (error) {
      next(error);
    }
  };

  cancel: RequestHandler = async (req, res, next) => {
    try {
      res.json(await this.service.cancel(req.params.id));
    } catch (error) {
      next(error);
    }
  };

  assign: RequestHandler = async (req, res, next) => {
    try {
      const body = assignPromotionSchema.parse(req.body);
      res.json(await this.service.assign(req.params.id, body));
    } catch (error) {
      next(error);
    }
  };

  list: RequestHandler = async (_req, res, next) => {
    try {
      res.json(await this.service.list());
    } catch (error) {
      next(error);
    }
  };
}
