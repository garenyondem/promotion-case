import { Router } from 'express';
import type { AppContext } from '../../app-context';
import { PromotionRepository } from '../promotions/promotion.repository';
import { ProductController } from './product.controller';
import { ProductRepository } from './product.repository';
import { ProductService } from './product.service';

export function productRoutes(ctx: AppContext): Router {
  const products = new ProductRepository();
  const promotions = new PromotionRepository();
  const service = new ProductService(products, promotions, ctx.cache);
  const controller = new ProductController(service);
  const router = Router();
  router.get('/', controller.list);
  router.get('/:id', controller.getById);
  router.post('/', controller.create);
  router.patch('/:id', controller.update);
  return router;
}
