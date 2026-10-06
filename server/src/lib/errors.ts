export class AppError extends Error {
  constructor(
    public status: 400 | 401 | 402 | 403 | 404 | 409 | 422 | 423 | 429 | 500 | 502,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message)
  }
}

export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'bad_request', msg, details)
export const unauthorized = (msg = 'Sign in first.') => new AppError(401, 'unauthorized', msg)
export const forbidden = (msg = 'You do not have access to this.') => new AppError(403, 'forbidden', msg)
export const notFound = (what = 'Item') => new AppError(404, 'not_found', `${what} not found.`)
export const conflict = (msg: string, code = 'conflict') => new AppError(409, code, msg)
export const unprocessable = (msg: string, code = 'invalid_state') => new AppError(422, code, msg)

// The client's subscription or plan does not allow this.
export const paymentRequired = (msg: string, code = 'subscription_inactive', details?: unknown) => new AppError(402, code, msg, details)
