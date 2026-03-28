export interface ToolInfoDto {
  name: string;
  description: string;
  safety: 'safe' | 'moderate' | 'dangerous';
  timeoutMs?: number;
  parameters: string[];
}
