/**
 * TanStack Query + WS module_request 統合フック
 *
 * WS の module_request を queryFn として使い、
 * キャッシュ・ローディング・エラー・再取得を宣言的に管理する。
 */

import { useQuery, useMutation } from "@tanstack/react-query";
import type { UseQueryOptions, UseMutationOptions } from "@tanstack/react-query";
import { wsClient } from "../lib/ws-client";

/**
 * WS module_request をクエリとして使う
 *
 * @example
 * const { data, isLoading } = useWsQuery(["profile"], "profile", "get");
 * const { data } = useWsQuery(["org", orgId], "organization", "get", { organizationId: orgId });
 */
export function useWsQuery<T = unknown>(
  queryKey: unknown[],
  module: string,
  action: string,
  payload?: Record<string, unknown>,
  options?: Omit<UseQueryOptions<T>, "queryKey" | "queryFn">,
) {
  return useQuery<T>({
    queryKey,
    queryFn: () => wsClient.sendCommand<T>(module, action, payload),
    enabled: wsClient.connected,
    ...options,
  });
}

/**
 * WS module_request をミューテーションとして使う
 *
 * @example
 * const mutation = useWsMutation("profile", "update", {
 *   onSuccess: () => queryClient.invalidateQueries({ queryKey: ["profile"] }),
 * });
 * mutation.mutate({ bio: "Hello" });
 */
export function useWsMutation<TPayload = Record<string, unknown>, TResult = unknown>(
  module: string,
  action: string,
  options?: Omit<UseMutationOptions<TResult, Error, TPayload>, "mutationFn">,
) {
  return useMutation<TResult, Error, TPayload>({
    mutationFn: (payload) =>
      wsClient.sendCommand<TResult>(module, action, payload as Record<string, unknown>),
    ...options,
  });
}
