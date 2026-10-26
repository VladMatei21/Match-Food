import { standaloneApi } from './standalone-api';

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (import.meta.env.MODE === 'standalone') return standaloneApi<T>(path, options);
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    credentials: 'same-origin'
  });
  const data = await response.json().catch(() => null);
  if (data === null || typeof data !== 'object') {
    throw new Error('We couldn’t connect to MatchFood. Please reload and try again.');
  }
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Something went wrong. Please try again.');
  return data as T;
}
export const post = <T>(path: string, data: unknown) => api<T>(path, {method:'POST',body:JSON.stringify(data)});
export const patch = <T>(path: string, data: unknown) => api<T>(path, {method:'PATCH',body:JSON.stringify(data)});
