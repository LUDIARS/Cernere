import bcrypt from "bcryptjs";

const BCRYPT_COST = 12;

/** DB保存用hashと、一度だけ呼び出し元へ返す平文secretを発行する。 */
export async function issueProjectSecret(): Promise<{
  clientSecret: string;
  clientSecretHash: string;
}> {
  const clientSecret = crypto.randomUUID();
  const clientSecretHash = await bcrypt.hash(clientSecret, BCRYPT_COST);
  return { clientSecret, clientSecretHash };
}
