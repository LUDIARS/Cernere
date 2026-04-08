// Core
export { CernereAuth } from "./client.js";
export type {
  CernereAuthConfig,
  CernereAuthResult,
  CernereUser,
  CernereTokens,
  AuthStorage,
  PopupOptions,
} from "./types.js";

// Storage
export {
  createLocalStorage,
  createSessionStorage,
  createMemoryStorage,
} from "./storage.js";

// React (re-export for convenience)
export {
  CernereAuthProvider,
  useCernereAuth,
  LoginOverlay,
  LoginPage,
} from "./react/index.js";
export type {
  CernereAuthProviderProps,
  CernereAuthContextValue,
  LoginOverlayProps,
  LoginPageProps,
} from "./react/index.js";
