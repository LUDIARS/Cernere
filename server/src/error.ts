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
  /** 入力形式は妥当だが内容を処理できない (顔が写っていない写真など)。 */
  static unprocessable(msg: string) { return new AppError(422, msg); }
  static internal(msg: string) { return new AppError(500, msg); }
  /** 依存する鍵 / 外部サービスが未設定・到達不能で fail closed するとき。 */
  static serviceUnavailable(msg: string) { return new AppError(503, msg); }
}
