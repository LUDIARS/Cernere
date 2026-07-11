import bcrypt from "bcryptjs";

const BCRYPT_COST = 12;

/** 外部launcher等から受け取ったproject secretを認証用bcrypt hashへ変換する。 */
export async function hashProjectSecret(clientSecret: string): Promise<string> {
  if (clientSecret.length < 32) throw new Error("project client secret must be at least 32 characters");
  return bcrypt.hash(clientSecret, BCRYPT_COST);
}

/** 保存済みの一方向 hash に対して project secret を検証する。 */
export async function verifyProjectSecret(clientSecret: string, hash: string): Promise<boolean> {
  return bcrypt.compare(clientSecret, hash);
}

/** DB保存用hashと、一度だけ呼び出し元へ返す平文secretを発行する。 */
export async function issueProjectSecret(): Promise<{
  clientSecret: string;
  clientSecretHash: string;
}> {
  const clientSecret = crypto.randomUUID();
  const clientSecretHash = await hashProjectSecret(clientSecret);
  return { clientSecret, clientSecretHash };
}
