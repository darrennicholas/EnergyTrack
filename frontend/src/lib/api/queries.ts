// TanStack Vue Query helpers layered on the central API client. This is the server-state layer
// the FSD (section 2) specifies: fetch, cache, retry. Use useApiQuery for declarative reads in
// components, and the queryClient helpers for imperative cache-aware fetches and invalidation.
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/vue-query'
import { computed, type MaybeRefOrGetter, toValue } from 'vue'
import { request } from './client'

// A stable key scoped by the current session so a logout or org switch never serves another
// user's cached data.
export function apiKey(scope: { userId?: string; organizationId?: string }, ...parts: unknown[]) {
  return ['api', scope.userId ?? null, scope.organizationId ?? null, ...parts] as const
}

// Declarative read for components. Pass a reactive path; the query re-runs when it changes.
export function useApiQuery<T>(scope: { userId?: string; organizationId?: string }, key: unknown[], path: MaybeRefOrGetter<string>, options: { enabled?: MaybeRefOrGetter<boolean>; staleTime?: number } = {}) {
  return useQuery({
    queryKey: computed(() => apiKey(scope, ...key, toValue(path))),
    queryFn: () => request<T>(toValue(path)),
    staleTime: options.staleTime ?? 30_000,
    enabled: options.enabled
  })
}

// Imperative cache-aware fetch, equivalent to the previous inline cachedRequest helper.
export function fetchCached<T>(queryClient: QueryClient, scope: { userId?: string; organizationId?: string }, key: unknown[], path: string, staleTime = 30_000) {
  return queryClient.fetchQuery({ queryKey: apiKey(scope, ...key), queryFn: () => request<T>(path), staleTime })
}

export { useQueryClient }
