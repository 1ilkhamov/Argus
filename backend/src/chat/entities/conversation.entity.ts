import { DEFAULT_CONVERSATION_TITLE } from '../../common/constants';
import { Message } from './message.entity';

export class Conversation {
  readonly id: string;
  readonly scopeKey: string;
  title: string;
  private readonly _messages: Message[];
  readonly createdAt: Date;
  updatedAt: Date;

  constructor(params?: {
    id?: string;
    scopeKey?: string;
    title?: string;
    messages?: Message[];
    createdAt?: Date;
    updatedAt?: Date;
  }) {
    this.id = params?.id ?? crypto.randomUUID();
    this.scopeKey = params?.scopeKey ?? 'local:default';
    this.title = params?.title ?? DEFAULT_CONVERSATION_TITLE;
    this._messages = params?.messages ?? [];
    this.createdAt = params?.createdAt ?? new Date();
    this.updatedAt = params?.updatedAt ?? this.createdAt;
  }

  get messages(): readonly Message[] {
    return this._messages;
  }

  get messageCount(): number {
    return this._messages.length;
  }

  addMessage(message: Message): void {
    this._messages.push(message);
    this.updatedAt = new Date();
  }

  getMessageHistory(): { role: Message['role']; content: string }[] {
    return this._messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
  }
}
