import { Request, Response, NextFunction } from "express";
import { StellarService } from "../services/stellar/stellarService";
import { MobileMoneyService } from "../services/mobilemoney/mobileMoneyService";
import { TransactionModel, TransactionStatus } from "../models/transaction";
import { lockManager, LockKeys } from "../utils/lock";
import { TransactionLimitService } from "../services/transactionLimit/transactionLimitService";
import { KYCService } from "../services/kyc/kycService";
import { addTransactionJob, getJobProgress } from "../queue";

// ------------------ Services ------------------
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const stellarService = new StellarService();
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const mobileMoneyService = new MobileMoneyService();
const transactionModel = new TransactionModel();
const kycService = new KYCService();
const transactionLimitService = new TransactionLimitService(
  kycService,
  transactionModel,
);

// ------------------ Handlers ------------------
export const depositHandler = async (req: Request, res: Response) => {
  try {
    const { amount, phoneNumber, provider, stellarAddress, userId, notes } =
      req.body;

    const limitCheck = await transactionLimitService.checkTransactionLimit(
      userId,
      parseFloat(amount),
    );

    if (!limitCheck.allowed) {
      return res.status(400).json({
        error: "Transaction limit exceeded",
        details: limitCheck,
      });
    }

    const result = await lockManager.withLock(
      LockKeys.phoneNumber(phoneNumber),
      async () => {
        const transaction = await transactionModel.create({
          type: "deposit",
          amount,
          phoneNumber,
          provider,
          stellarAddress,
          status: TransactionStatus.Pending,
          tags: [],
          notes,
        });

        const job = await addTransactionJob({
          transactionId: transaction.id,
          type: "deposit",
          amount,
          phoneNumber,
          provider,
          stellarAddress,
        });

        return {
          transactionId: transaction.id,
          referenceNumber: transaction.referenceNumber,
          status: TransactionStatus.Pending,
          jobId: job.id,
        };
      },
      15000,
    );

    res.json(result);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Unable to acquire lock")
    ) {
      return res
        .status(409)
        .json({
          error: "Transaction already in progress for this phone number",
        });
    }
    res.status(500).json({ error: "Transaction failed" });
  }
};

export const withdrawHandler = async (req: Request, res: Response) => {
  try {
    const { amount, phoneNumber, provider, stellarAddress, userId, notes } =
      req.body;

    const limitCheck = await transactionLimitService.checkTransactionLimit(
      userId,
      parseFloat(amount),
    );

    if (!limitCheck.allowed) {
      return res.status(400).json({
        error: "Transaction limit exceeded",
        details: limitCheck,
      });
    }

    const result = await lockManager.withLock(
      LockKeys.phoneNumber(phoneNumber),
      async () => {
        const transaction = await transactionModel.create({
          type: "withdraw",
          amount,
          phoneNumber,
          provider,
          stellarAddress,
          status: TransactionStatus.Pending,
          tags: [],
          notes,
        });

        const job = await addTransactionJob({
          transactionId: transaction.id,
          type: "withdraw",
          amount,
          phoneNumber,
          provider,
          stellarAddress,
        });

        return {
          transactionId: transaction.id,
          referenceNumber: transaction.referenceNumber,
          status: TransactionStatus.Pending,
          jobId: job.id,
        };
      },
      15000,
    );

    res.json(result);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("Unable to acquire lock")
    ) {
      return res
        .status(409)
        .json({
          error: "Transaction already in progress for this phone number",
        });
    }
    res.status(500).json({ error: "Transaction failed" });
  }
};

export const getTransactionHandler = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const transaction = await transactionModel.findById(id);
    if (!transaction)
      return res.status(404).json({ error: "Transaction not found" });

    let jobProgress = null;
    if (transaction.status === TransactionStatus.Pending) {
      jobProgress = await getJobProgress(id);
    }

    const timeoutMinutes = Number(
      process.env.TRANSACTION_TIMEOUT_MINUTES || 30,
    );

    if (transaction.status === TransactionStatus.Pending) {
      const createdAt = new Date(transaction.createdAt).getTime();
      const diffMinutes = (Date.now() - createdAt) / (1000 * 60);

      if (diffMinutes > timeoutMinutes) {
        await transactionModel.updateStatus(id, TransactionStatus.Failed);
        transaction.status = TransactionStatus.Failed;
      }
    }
    res.json({ ...transaction, jobProgress });
  } catch (err) {
    console.error("Failed to fetch transaction:", err);
    res.status(500).json({ error: "Failed to fetch transaction" });
  }
};

export const cancelTransactionHandler = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const transaction = await transactionModel.findById(id);

    if (!transaction)
      return res.status(404).json({ error: "Transaction not found" });

    if (transaction.status !== TransactionStatus.Pending) {
      return res.status(400).json({
        error: `Cannot cancel transaction with status '${transaction.status}'`,
      });
    }

    await transactionModel.updateStatus(id, TransactionStatus.Cancelled);
    const updatedTransaction = await transactionModel.findById(id);

    if (process.env.WEBHOOK_URL && updatedTransaction) {
      fetch(process.env.WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "transaction.cancelled",
          data: updatedTransaction,
        }),
      }).catch((err) => console.error("Webhook notification failed", err));
    }

    return res.json({
      message: "Transaction cancelled successfully",
      transaction: updatedTransaction,
    });
  } catch (error) {
    console.error("Failed to cancel transaction:", error);
    return res.status(500).json({ error: "Failed to cancel transaction" });
  }
};

export const updateNotesHandler = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    if (typeof notes !== "string") {
      return res.status(400).json({ error: "Notes must be a string" });
    }

    const transaction = await transactionModel.updateNotes(id, notes);
    if (!transaction)
      return res.status(404).json({ error: "Transaction not found" });

    res.json(transaction);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to update notes";
    res
      .status(message.includes("characters") ? 400 : 500)
      .json({ error: message });
  }
};

export const updateAdminNotesHandler = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { admin_notes } = req.body;

    if (typeof admin_notes !== "string") {
      return res.status(400).json({ error: "Admin notes must be a string" });
    }

    const transaction = await transactionModel.updateAdminNotes(
      id,
      admin_notes,
    );
    if (!transaction)
      return res.status(404).json({ error: "Transaction not found" });

    res.json(transaction);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Failed to update admin notes";
    res
      .status(message.includes("characters") ? 400 : 500)
      .json({ error: message });
  }
};

export const searchTransactionsHandler = async (
  req: Request,
  res: Response,
) => {
  try {
    const { q } = req.query;
    if (!q || typeof q !== "string") {
      return res.status(400).json({ error: "Query parameter 'q' is required" });
    }

    const transactions = await transactionModel.searchByNotes(q);
    res.json(transactions);
  } catch (err) {
    console.error("Search failed:", err);
    res.status(500).json({ error: "Search failed" });
  }
};
