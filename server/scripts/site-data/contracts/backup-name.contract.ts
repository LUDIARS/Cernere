export default {
  post: (result: string, database: string, now: Date): true | string => {
    const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "_");
    return (result === `${database}_backup_${stamp}`
      && result.length <= 63
      && /^[a-z_][a-z0-9_]*$/.test(result))
      || "backup name must be <database>_backup_<UTC YYYYMMDD_HHMMSS> and a safe identifier";
  },
  postThrow: (error: unknown): true | string =>
    (error instanceof Error && error.message.startsWith("site-data: invalid_config")) || "unsafe database names must be rejected",
};
