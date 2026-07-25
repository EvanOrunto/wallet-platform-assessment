import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type LedgerEntryDocument = HydratedDocument<LedgerEntry>;

export enum LedgerEntryDirection {
  DEBIT = 'DEBIT',
  CREDIT = 'CREDIT',
}

@Schema({ timestamps: true, collection: 'ledger_entries' })
export class LedgerEntry {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Transaction', required: true })
  transactionId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Wallet', required: true })
  walletId: Types.ObjectId;

  @Prop({ type: String, enum: LedgerEntryDirection, required: true })
  direction: LedgerEntryDirection;

  @Prop({ required: true })
  amount: number;

  @Prop({ required: true })
  balanceAfter: number;

  createdAt?: Date;
  updatedAt?: Date;
}

export const LedgerEntrySchema = SchemaFactory.createForClass(LedgerEntry);

LedgerEntrySchema.index({ transactionId: 1 });
