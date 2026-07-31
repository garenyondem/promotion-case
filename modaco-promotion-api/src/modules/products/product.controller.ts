import { z } from 'zod';
import type { RequestHandler } from 'express';
import type { ProductService } from './product.service';

const listQuerySchema = z.object({
  category: z.string().optional(),
  sort: z.enum(['price_asc', 'price_desc', 'created_at']).default('price_asc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const createProductSchema = z.object({
  sku: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  basePrice: z.number().min(0),
  stockQuantity: z.number().int().min(0).default(0),
});

const updateProductSchema = z
  .object({
    sku: z.string().min(1).max(64).optional(),
    name: z.string().min(1).max(200).optional(),
    category: z.string().min(1).max(100).optional(),
    basePrice: z.number().min(0).optional(),
    stockQuantity: z.number().int().min(0).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'At least one field is required' });

export class ProductController {
  constructor(private readonly service: ProductService) {}

  list: RequestHandler = async (req, res, next) => {
    try {
      const query = listQuerySchema.parse(req.query);
      res.json(await this.service.list(query));
    } catch (error) {
      next(error);
    }
  };

  getById: RequestHandler = async (req, res, next) => {
    try {
      res.json(await this.service.getById(req.params.id));
    } catch (error) {
      next(error);
    }
  };

  create: RequestHandler = async (req, res, next) => {
    try {
      const body = createProductSchema.parse(req.body);
      res.status(201).json(await this.service.create(body));
    } catch (error) {
      next(error);
    }
  };

  update: RequestHandler = async (req, res, next) => {
    try {
      const body = updateProductSchema.parse(req.body);
      res.json(await this.service.update(req.params.id, body));
    } catch (error) {
      next(error);
    }
  };
}
