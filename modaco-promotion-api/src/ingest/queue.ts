import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { SQSClient, SendMessageBatchCommand, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';

export interface QueueMessage {
  body: string;
  receiptId: string;
}

export interface MessageQueue {
  sendMessages(messages: string[]): Promise<void>;
  receiveMessages(max: number): Promise<QueueMessage[]>;
  deleteMessage(receiptId: string): Promise<void>;
}

export class LocalQueue implements MessageQueue {
  constructor(private readonly dir: string) {}

  private async ensure(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
  }

  async sendMessages(messages: string[]): Promise<void> {
    await this.ensure();
    for (const body of messages) {
      await fsp.writeFile(join(this.dir, `${randomUUID()}.json`), body);
    }
  }

  async receiveMessages(max: number): Promise<QueueMessage[]> {
    await this.ensure();
    const files = (await fsp.readdir(this.dir)).filter((f) => f.endsWith('.json'));
    const result: QueueMessage[] = [];
    for (const file of files) {
      if (result.length >= max) {
        break;
      }
      const lock = `${file}.lock`;
      let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
      try {
        handle = await fsp.open(join(this.dir, lock), 'wx');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          continue;
        }
        throw error;
      }
      await handle.close();
      const body = await fsp.readFile(join(this.dir, file), 'utf8');
      await fsp.rm(join(this.dir, file), { force: true });
      result.push({ body, receiptId: lock });
    }
    return result;
  }

  async deleteMessage(receiptId: string): Promise<void> {
    await fsp.rm(join(this.dir, receiptId), { force: true });
  }
}

export class SQSQueue implements MessageQueue {
  constructor(
    private readonly client: SQSClient,
    private readonly url: string,
  ) {}

  async sendMessages(messages: string[]): Promise<void> {
    for (let i = 0; i < messages.length; i += 10) {
      const batch = messages.slice(i, i + 10).map((body, index) => ({ Id: `${i}-${index}`, MessageBody: body }));
      await this.client.send(new SendMessageBatchCommand({ QueueUrl: this.url, Entries: batch }));
    }
  }

  async receiveMessages(max: number): Promise<QueueMessage[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({ QueueUrl: this.url, MaxNumberOfMessages: max, WaitTimeSeconds: 1 }),
    );
    return (response.Messages ?? []).map((m) => ({ body: m.Body ?? '', receiptId: m.ReceiptHandle ?? '' }));
  }

  async deleteMessage(receiptId: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.url, ReceiptHandle: receiptId }));
  }
}
