import { IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import { AGENT_MODE_IDS, type AgentModeId } from '../../agent/modes/mode.types';

export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(32000)
  content!: string;

  @IsUUID()
  @IsOptional()
  conversationId?: string;

  @IsOptional()
  @IsIn(AGENT_MODE_IDS)
  mode?: AgentModeId;
}
