import { apiFetch } from '../http/client';
import { API_ENDPOINTS } from '@/config';

export interface SettingDto {
  key: string;
  value: string;
  sensitive: boolean;
  updatedAt: string | null;
}

export const settingsApi = {
  getAll(): Promise<SettingDto[]> {
    return apiFetch<SettingDto[]>(API_ENDPOINTS.settings.list);
  },

  update(key: string, value: string): Promise<SettingDto> {
    return apiFetch<SettingDto>(API_ENDPOINTS.settings.entry(key), {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
  },

  remove(key: string): Promise<{ deleted: boolean }> {
    return apiFetch<{ deleted: boolean }>(API_ENDPOINTS.settings.entry(key), {
      method: 'DELETE',
    });
  },
};
