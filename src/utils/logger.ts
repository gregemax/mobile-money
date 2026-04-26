import pino from 'pino';

/**
 * Centralized Pino Logger Configuration
 * 
 * Features:
 * - JSON output by default (stdout)
 * - Redaction of sensitive fields
 * - Custom levels: Security and Audit
 * - ISO timestamp format
 */
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  
  // Custom levels for Security and Audit logs
  customLevels: {
    security: 35,
    audit: 45,
  },

  // Format the level as uppercase string for better Loki/Grafana compatibility
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
  },

  // Redaction of sensitive fields to prevent PII/Secrets leakage in logs
  redact: {
    paths: [
      'password',
      'token',
      'accountNumber',
      'secret',
      'authorization',
      'req.headers.authorization',
      '*.password',
      '*.token',
      '*.accountNumber'
    ],
    placeholder: '[REDACTED]',
    censor: '[REDACTED]'
  },

  // Use ISO 8601 timestamps
  timestamp: pino.stdTimeFunctions.isoTime,
});

export default logger;
