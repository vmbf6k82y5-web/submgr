/**
 * 统一的 API 错误模型。
 *
 * 所有错误响应形状一致：
 *   { "error": { "code": "invalid_request", "message": "人能看懂的中文", "details": {...} } }
 *
 * route 里直接 throw ApiError，由 index.ts 的 onError 统一序列化。
 */

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toBody(): ApiErrorBody {
    const body: ApiErrorBody = { error: { code: this.code, message: this.message } };
    if (this.details !== undefined) body.error.details = this.details;
    return body;
  }
}

/** 400：请求体/查询参数不合法。 */
export function invalid(message: string, details?: unknown): ApiError {
  return new ApiError(400, 'invalid_request', message, details);
}

/** 404：资源不存在（或已软删除）。 */
export function notFound(message: string, details?: unknown): ApiError {
  return new ApiError(404, 'not_found', message, details);
}

/** 409：与数据库约束冲突（同日版本、重名、已冻结等）。 */
export function conflict(code: string, message: string, details?: unknown): ApiError {
  return new ApiError(409, code, message, details);
}

/** 401：鉴权失败。 */
export function unauthorized(message = '缺少或无效的 ADMIN_TOKEN'): ApiError {
  return new ApiError(401, 'unauthorized', message);
}
