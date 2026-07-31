import { Router } from 'express';
import type { AppContext } from '../../app-context';
import { ProductRepository } from '../products/product.repository';
import { PromotionController } from './promotion.controller';
import { PromotionRepository } from './promotion.repository';
import { PromotionService } from './promotion.service';

export function promotionRoutes(ctx: AppContext): Router {
  const products = new ProductRepository();
  const service = new PromotionService(
    new PromotionRepository(),
    ctx.cache,
    (id) => products.findById(id).then((p) => p !== null),
  );
  const controller = new PromotionController(service);
  const router = Router();
  router.get('/', controller.list);
  router.post('/', controller.create);
  router.post('/:id/cancel', controller.cancel);
  router.post('/:id/assign', controller.assign);
  return router;
}
