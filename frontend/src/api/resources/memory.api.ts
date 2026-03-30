import { apiFetch } from '../http/client';
import { API_ENDPOINTS } from '@/config';
import type { MemoryEntryDto, MemoryKind, MemoryListResponse, MemoryStatsResponse } from '@/types/memory.types';

export const memoryApi = {
  listEntries(kind?: MemoryKind): Promise<MemoryListResponse> {
    const params = kind ? `?kind=${kind}&limit=200` : '?limit=200';
    return apiFetch<MemoryListResponse>(`${API_ENDPOINTS.memory.entries}${params}`);
  },

  deleteEntry(id: string): Promise<void> {
    return apiFetch<void>(API_ENDPOINTS.memory.entry(id), { method: 'DELETE' });
  },

  pinEntry(id: string, pinned: boolean): Promise<MemoryEntryDto> {
    return apiFetch<MemoryEntryDto>(API_ENDPOINTS.memory.pin(id), {
      method: 'POST',
      body: JSON.stringify({ pinned }),
    });
  },

  getStats(): Promise<MemoryStatsResponse> {
    return apiFetch<MemoryStatsResponse>(API_ENDPOINTS.memory.stats);
  },

  createEntry(data: { kind: MemoryKind; content: string; category?: string; pinned?: boolean }): Promise<MemoryEntryDto> {
    return apiFetch<MemoryEntryDto>(API_ENDPOINTS.memory.entries, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
};
