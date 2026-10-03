export default {
  post: (result: string[], existing: string[], added: string[]): true | string =>
    JSON.stringify(result) === JSON.stringify([...new Set([...existing, ...added])])
      || "binding names must preserve existing order and append missing names",
};
