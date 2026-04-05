/**
 * アプリケーションエラー型
 */

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }

  static badRequest(msg: string) { return new AppError(400, msg); }
  static unauthorized(msg: string) { return new AppError(401, msg); }
  static forbidden(msg: string) { return new AppError(403, msg); }
  static notFound(msg: string) { return new AppError(404, msg); }
  static conflict(msg: string) { return new AppError(409, msg); }
  static internal(msg: string) { return new AppError(500, msg); }
}
