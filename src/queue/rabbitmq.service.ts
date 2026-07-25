import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqp-connection-manager';
import { ChannelWrapper } from 'amqp-connection-manager';
import { ConfirmChannel } from 'amqplib';

@Injectable()
export class RabbitMQService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMQService.name);
  private connection: amqp.AmqpConnectionManager;
  private channelWrapper: ChannelWrapper;
  private readonly exchange: string;
  private readonly transferQueue: string;

  constructor(private readonly configService: ConfigService) {
    this.exchange = this.configService.getOrThrow<string>('rabbitmq.exchange');
    this.transferQueue = this.configService.getOrThrow<string>('rabbitmq.transferQueue');
  }

  async onModuleInit() {
    const uri = this.configService.getOrThrow<string>('rabbitmq.uri');
    this.connection = amqp.connect([uri]);
    this.connection.on('connectFailed', (err) =>
      this.logger.error(`RabbitMQ connection failed: ${err?.err?.message}`),
    );

    this.channelWrapper = this.connection.createChannel({
      json: true,
      setup: (channel: ConfirmChannel) =>
        Promise.all([
          channel.assertExchange(this.exchange, 'topic', { durable: true }),
          channel.assertExchange(`${this.exchange}.dlx`, 'topic', { durable: true }),
          channel.assertQueue(`${this.transferQueue}.dlq`, { durable: true }),
          channel.bindQueue(`${this.transferQueue}.dlq`, `${this.exchange}.dlx`, '#'),
          channel.assertQueue(this.transferQueue, {
            durable: true,
            deadLetterExchange: `${this.exchange}.dlx`,
          }),
          channel.bindQueue(this.transferQueue, this.exchange, 'transfer.*'),
        ]),
    });
  }

  async publish(routingKey: string, payload: Record<string, unknown>): Promise<void> {
    await this.channelWrapper.publish(this.exchange, routingKey, payload, {
      persistent: true,
    });
    this.logger.log(`Published event ${routingKey}`);
  }

  getChannelWrapper(): ChannelWrapper {
    return this.channelWrapper;
  }

  getTransferQueue(): string {
    return this.transferQueue;
  }

  async onModuleDestroy() {
    await this.channelWrapper?.close();
    await this.connection?.close();
  }
}
