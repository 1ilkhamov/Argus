export type MessageRole = 'system' | 'user' | 'assistant';

export class Message {
  readonly id: string;
  readonly conversationId: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly createdAt: Date;

  constructor(params: {
    id?: string;
    conversationId: string;
    role: MessageRole;
    content: string;
    createdAt?: Date;
  }) {
    this.id = params.id ?? crypto.randomUUID();
    this.conversationId = params.conversationId;
    this.role = params.role;
    this.content = params.content;
    this.createdAt = params.createdAt ?? new Date();
  }
}
