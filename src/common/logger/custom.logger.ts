import { ConsoleLogger, Injectable, Scope } from '@nestjs/common';
import { correlationIdStorage } from './correlation-id.storage';

@Injectable({ scope: Scope.TRANSIENT })
export class CustomLogger extends ConsoleLogger {
  protected formatMessage(
    logLevel: 'log' | 'error' | 'warn' | 'debug' | 'verbose' | 'fatal',
    message: unknown,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
  ): string {
    const correlationId = correlationIdStorage.getStore();
    
    // Instead of overriding everything manually, we simply prepend the correlationId to the standard message
    // if it exists in the AsyncLocalStorage context.
    const prefix = correlationId ? `[${correlationId}] ` : '';
    
    const stringifiedMessage = typeof message === 'string' ? message : JSON.stringify(message);
    const newMessage = `${prefix}${stringifiedMessage}`;
    
    return super.formatMessage(
      logLevel,
      newMessage,
      pidMessage,
      formattedLogLevel,
      contextMessage,
      timestampDiff,
    );
  }
}
