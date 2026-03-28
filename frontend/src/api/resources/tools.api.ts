import { apiFetch } from '../http/client';
import { API_ENDPOINTS } from '@/config';
import type { ToolInfoDto } from '@/types/tools.types';

export const toolsApi = {
  listTools(): Promise<ToolInfoDto[]> {
    return apiFetch<ToolInfoDto[]>(API_ENDPOINTS.tools.list);
  },
};
