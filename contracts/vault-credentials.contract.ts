export default {
  post: (result: unknown): true | string => result === undefined || "credentials must not be returned",
  postThrow: (error: unknown): true | string => (error instanceof Error
    && error.message === "Vault credential save failed; Cernere DB was not updated")
    || "failure must not contain credentials or remote error details",
};
