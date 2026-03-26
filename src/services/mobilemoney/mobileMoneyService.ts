import { MTNProvider } from "./providers/mtn";
import { AirtelProvider } from "./providers/airtel";
import { OrangeProvider } from "./providers/orange";
import {
  transactionTotal,
  transactionErrorsTotal,
  providerResponseTimeSeconds,
  slowRequestsTotal,
  timeoutRequestsTotal,
} from "../../utils/metrics";

interface MobileMoneyProvider {
  requestPayment(
    phoneNumber: string,
    amount: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }>;
  sendPayout(
    phoneNumber: string,
    amount: string,
  ): Promise<{ success: boolean; data?: unknown; error?: unknown }>;
}

class MobileMoneyError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "MobileMoneyError";
  }
}

export class MobileMoneyService {
  private providers: Map<string, MobileMoneyProvider>;

  constructor() {
    this.providers = new Map<string, MobileMoneyProvider>([
      ["mtn", new MTNProvider()],
      ["airtel", new AirtelProvider()],
      ["orange", new OrangeProvider()],
    ]);
  }

  private async executeWithTracking(
    provider: string,
    operation: string,
    fn: () => Promise<{ success: boolean; data?: unknown; error?: unknown }>,
  ) {
    const start = process.hrtime();
    let status = "success";

    try {
      const result = await fn();
      if (!result.success) {
        status = "failure";
      }
      return result;
    } catch (error) {
      status = "error";
      const err = error as { code?: string; message?: string };
      if (
        err.code === "ECONNABORTED" ||
        err.message?.toLowerCase().includes("timeout")
      ) {
        timeoutRequestsTotal.inc({ provider, operation });
      }
      throw error;
    } finally {
      const duration = process.hrtime(start);
      const durationSeconds = duration[0] + duration[1] / 1e9;

      providerResponseTimeSeconds.observe(
        { provider, operation, status },
        durationSeconds,
      );

      if (durationSeconds > 5) {
        slowRequestsTotal.inc({ provider, operation });
        console.warn(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "warn",
            message: "Slow mobile money provider response",
            provider,
            operation,
            durationSeconds: Math.round(durationSeconds * 1000) / 1000,
          }),
        );
      }
    }
  }

  async initiatePayment(provider: string, phoneNumber: string, amount: string) {
    const providerKey = provider.toLowerCase();
    const providerInstance = this.providers.get(providerKey);

    if (!providerInstance) {
      const availableProviders = Array.from(this.providers.keys()).join(", ");
      throw new MobileMoneyError(
        "PROVIDER_NOT_SUPPORTED",
        `Provider '${provider}' not supported. Available: ${availableProviders}`,
      );
    }

    try {
      const result = await this.executeWithTracking(
        providerKey,
        "payment",
        () => providerInstance.requestPayment(phoneNumber, amount),
      );

      if (result.success) {
        transactionTotal.inc({
          type: "payment",
          provider: providerKey,
          status: "success",
        });
        return result;
      }

      transactionTotal.inc({
        type: "payment",
        provider: providerKey,
        status: "failure",
      });
      transactionErrorsTotal.inc({
        type: "payment",
        provider: providerKey,
        error_type: "provider_error",
      });

      throw new MobileMoneyError(
        "PROVIDER_ERROR",
        `Payment failed with provider '${providerKey}'`,
      );
    } catch (error) {
      transactionTotal.inc({
        type: "payment",
        provider: providerKey,
        status: "failure",
      });
      transactionErrorsTotal.inc({
        type: "payment",
        provider: providerKey,
        error_type: "exception",
      });

      if (error instanceof MobileMoneyError) {
        throw error;
      }

      throw new MobileMoneyError(
        "INTERNAL_ERROR",
        `Unexpected error during payment with provider '${providerKey}'`,
      );
    }
  }

  async sendPayout(provider: string, phoneNumber: string, amount: string) {
    const providerKey = provider.toLowerCase();
    const providerInstance = this.providers.get(providerKey);

    if (!providerInstance) {
      const availableProviders = Array.from(this.providers.keys()).join(", ");
      throw new MobileMoneyError(
        "PROVIDER_NOT_SUPPORTED",
        `Provider '${provider}' not supported. Available: ${availableProviders}`,
      );
    }

    try {
      const result = await this.executeWithTracking(providerKey, "payout", () =>
        providerInstance.sendPayout(phoneNumber, amount),
      );

      if (result.success) {
        transactionTotal.inc({
          type: "payout",
          provider: providerKey,
          status: "success",
        });
        return result;
      }

      transactionTotal.inc({
        type: "payout",
        provider: providerKey,
        status: "failure",
      });
      transactionErrorsTotal.inc({
        type: "payout",
        provider: providerKey,
        error_type: "provider_error",
      });

      throw new MobileMoneyError(
        "PROVIDER_ERROR",
        `Payout failed with provider '${providerKey}'`,
      );
    } catch (error) {
      transactionTotal.inc({
        type: "payout",
        provider: providerKey,
        status: "failure",
      });
      transactionErrorsTotal.inc({
        type: "payout",
        provider: providerKey,
        error_type: "exception",
      });

      if (error instanceof MobileMoneyError) {
        throw error;
      }

      throw new MobileMoneyError(
        "INTERNAL_ERROR",
        `Unexpected error during payout with provider '${providerKey}'`,
      );
    }
  }
}
