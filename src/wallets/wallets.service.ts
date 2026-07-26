import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { LedgerEntry, LedgerEntryDocument } from '../ledger/schemas/ledger-entry.schema';
import { LedgerService } from '../ledger/ledger.service';
import { OutboxService } from '../outbox/outbox.service';
import { RabbitMQService } from '../queue/rabbitmq.service';
import { RedisService } from '../redis/redis.service';
import { TransactionsService } from '../transactions/transactions.service';
import {
  Transaction,
  TransactionDocument,
  TransactionStatus,
  TransactionType,
} from '../transactions/schemas/transaction.schema';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { DepositDto } from './dto/deposit.dto';
import { TransferDto } from './dto/transfer.dto';
import { WithdrawDto } from './dto/withdraw.dto';
import { Transfer, TransferDocument, TransferStatus } from './schemas/transfer.schema';
import { Wallet, WalletDocument } from './schemas/wallet.schema';

@Injectable()
export class WalletsService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Wallet.name) private readonly walletModel: Model<WalletDocument>,
    @InjectModel(Transfer.name) private readonly transferModel: Model<TransferDocument>,
    @InjectModel(Transaction.name) private readonly transactionModel: Model<TransactionDocument>,
    @InjectModel(LedgerEntry.name) private readonly ledgerEntryModel: Model<LedgerEntryDocument>,
    private readonly transactionsService: TransactionsService,
    private readonly ledgerService: LedgerService,
    private readonly outboxService: OutboxService,
    private readonly rabbitMQService: RabbitMQService,
    private readonly redisService: RedisService,
  ) {}

  async createWallet(dto: CreateWalletDto) {
    const session = await this.connection.startSession();
    let wallet!: WalletDocument;

    try {
      await session.withTransaction(async () => {
        [wallet] = await this.walletModel.create(
          [
            {
              userId: dto.userId,
              ownerName: dto.ownerName,
              currency: dto.currency ?? 'GHS',
              balance: 0,
            },
          ],
          { session },
        );

        await this.outboxService.enqueue(
          'wallet.created',
          {
            walletId: wallet._id.toString(),
            userId: wallet.userId,
            currency: wallet.currency,
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    return wallet;
  }

  async getWallet(id: string) {
    const wallet = await this.walletModel.findById(id);
    if (!wallet) {
      throw new NotFoundException(`Wallet ${id} not found`);
    }

    const cachedBalance = await this.redisService.getCachedBalance(id);
    if (cachedBalance !== null) {
      return { ...wallet.toObject(), balance: cachedBalance };
    }

    await this.redisService.setCachedBalance(id, wallet.balance);
    return wallet;
  }

  async deposit(id: string, dto: DepositDto) {
    const wallet = await this.walletModel.findByIdAndUpdate(
      id,
      { $inc: { balance: dto.amount } },
      { new: true },
    );

    if (!wallet) {
      throw new NotFoundException(`Wallet ${id} not found`);
    }

    const transaction = await this.transactionsService.create({
      walletId: wallet.id,
      type: TransactionType.DEPOSIT,
      amount: dto.amount,
      balanceAfter: wallet.balance,
      reference: dto.reference,
    });

    await this.ledgerService.recordCredit(wallet._id, transaction._id, dto.amount, wallet.balance);

    await this.redisService.invalidateBalance(wallet.id);

    return wallet;
  }

  async withdraw(id: string, dto: WithdrawDto) {
    const wallet = await this.walletModel.findOneAndUpdate(
      { _id: id, balance: { $gte: dto.amount } },
      { $inc: { balance: -dto.amount, version: 1 } },
      { new: true },
    );

    if (!wallet) {
      const existing = await this.walletModel.findById(id);
      if (!existing) {
        throw new NotFoundException(`Wallet ${id} not found`);
      }
      throw new BadRequestException('Insufficient balance');
    }

    const transaction = await this.transactionsService.create({
      walletId: wallet.id,
      type: TransactionType.WITHDRAWAL,
      amount: dto.amount,
      balanceAfter: wallet.balance,
      reference: dto.reference,
    });

    await this.ledgerService.recordDebit(wallet._id, transaction._id, dto.amount, wallet.balance);

    await this.redisService.invalidateBalance(wallet.id);

    return wallet;
  }

  async transfer(dto: TransferDto) {
    if (dto.fromWalletId === dto.toWalletId) {
      throw new BadRequestException('Cannot transfer to the same wallet');
    }

    // Check if this request is a duplicate retry
    if (dto.idempotencyKey) {
      const existingTransfer = await this.transferModel.findOne({ idempotencyKey: dto.idempotencyKey });
      if (existingTransfer) {
        return existingTransfer;
      }
    }

    const [fromWallet, toWallet] = await Promise.all([
      this.walletModel.findById(dto.fromWalletId),
      this.walletModel.findById(dto.toWalletId),
    ]);

    if (!fromWallet || !toWallet) {
      throw new NotFoundException('Wallet not found');
    }

    if (fromWallet.balance < dto.amount) {
      throw new BadRequestException('Insufficient balance');
    }

    const session = await this.connection.startSession();
    let transfer!: TransferDocument;

    try {
      await session.withTransaction(async () => {
        [transfer] = await this.transferModel.create(
          [
            {
              fromWalletId: fromWallet._id,
              toWalletId: toWallet._id,
              amount: dto.amount,
              status: TransferStatus.PENDING,
              idempotencyKey: dto.idempotencyKey,
            },
          ],
          { session },
        );

        fromWallet.balance -= dto.amount;
        await fromWallet.save({ session });

        const [debitTransaction] = await this.transactionModel.create(
          [
            {
              walletId: fromWallet._id,
              type: TransactionType.TRANSFER_OUT,
              amount: dto.amount,
              status: TransactionStatus.COMPLETED,
              balanceAfter: fromWallet.balance,
              transferId: transfer._id,
              counterpartyWalletId: toWallet._id,
            },
          ],
          { session },
        );

        await this.ledgerService.recordDebit(
          fromWallet._id,
          debitTransaction._id,
          dto.amount,
          fromWallet.balance,
          session,
        );

        await this.outboxService.enqueue(
          'transfer.initiated',
          {
            transferId: transfer._id.toString(),
            fromWalletId: fromWallet._id.toString(),
            toWalletId: toWallet._id.toString(),
            amount: dto.amount,
          },
          session,
        );
      });

      await this.redisService.invalidateBalance(fromWallet._id.toString());
    } finally {
      await session.endSession();
    }

    return transfer;
  }

  async getDashboard(id: string) {
    const wallet = await this.walletModel.findById(id);
    if (!wallet) {
      throw new NotFoundException(`Wallet ${id} not found`);
    }

    // Step 1: Push math to the database to avoid loading all transactions into memory
    const statsResult = await this.transactionModel.aggregate([
      { $match: { walletId: wallet._id } },
      {
        $group: {
          _id: null,
          transactionCount: { $sum: 1 },
          totalDeposited: {
            $sum: {
              $cond: [
                {
                  $in: [
                    '$type',
                    [TransactionType.DEPOSIT, TransactionType.TRANSFER_IN],
                  ],
                },
                '$amount',
                0,
              ],
            },
          },
          totalWithdrawn: {
            $sum: {
              $cond: [
                {
                  $in: [
                    '$type',
                    [TransactionType.WITHDRAWAL, TransactionType.TRANSFER_OUT],
                  ],
                },
                '$amount',
                0,
              ],
            },
          },
        },
      },
    ]);

    const stats = statsResult[0] || {
      transactionCount: 0,
      totalDeposited: 0,
      totalWithdrawn: 0,
    };

    // Fetch only the top 10 recent transactions
    const recentTransactions = await this.transactionModel
      .find({ walletId: wallet._id })
      .sort({ createdAt: -1 })
      .limit(10)
      .exec();

    // Fetch all ledger entries for those 10 transactions in a SINGLE query 
    const transactionIds = recentTransactions.map((t) => t._id);
    const allRecentEntries = await this.ledgerEntryModel
      .find({ transactionId: { $in: transactionIds } })
      .exec();

    // Group the ledger entries by transactionId in memory
    const entriesByTransaction = allRecentEntries.reduce((acc, entry) => {
      const txId = entry.transactionId.toString();
      if (!acc[txId]) {
        acc[txId] = [];
      }
      acc[txId].push(entry);
      return acc;
    }, {} as Record<string, LedgerEntryDocument[]>);

    const recentActivity = recentTransactions.map((txn) => ({
      transaction: txn,
      entries: entriesByTransaction[txn._id.toString()] || [],
    }));

    return {
      wallet,
      totalDeposited: stats.totalDeposited,
      totalWithdrawn: stats.totalWithdrawn,
      transactionCount: stats.transactionCount,
      recentActivity,
    };
  }
}
