import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

import { AGENT_MODE_IDS, type AgentModeId } from '../../agent/modes/mode.types';

/**
 * DTO for voice message uploads (multipart/form-data).
 * The audio file is handled by multer via @UploadedFile(), not part of the DTO.
 */
export class VoiceMessageDto {
  @IsUUID()
  @IsOptional()
  conversationId?: string;

  @IsOptional()
  @IsIn(AGENT_MODE_IDS)
  mode?: AgentModeId;

  @IsString()
  @IsOptional()
  language?: string;
}
