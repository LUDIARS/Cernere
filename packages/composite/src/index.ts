export { CernereComposite } from "./composite.js";
export type {
  CompositeConfig,
  CernereUser,
  ExchangeResult,
} from "./types.js";

// service-adapter の型を re-export (利用側の便宜)
export type {
  ServiceAdapterCallbacks,
  AdmittedUser,
} from "@ludiars/cernere-service-adapter";
