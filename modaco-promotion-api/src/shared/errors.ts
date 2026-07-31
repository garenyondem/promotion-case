export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const errors = {
  notFound: (message = 'Resource not found') => new AppError(404, 'NOT_FOUND', message),
  badRequest: (message = 'Bad request') => new AppError(400, 'BAD_REQUEST', message),
  conflict: (message = 'Conflict') => new AppError(409, 'CONFLICT', message),
  validation: (message = 'Invalid input') => new AppError(400, 'VALIDATION_ERROR', message),
  internal: (message = 'Internal server error') => new AppError(500, 'INTERNAL_ERROR', message),
};
