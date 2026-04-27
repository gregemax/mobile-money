import logger from '../logger';

describe('Logger Utility', () => {
  let logOutput: any[] = [];
  const originalWrite = process.stdout.write;

  beforeAll(() => {
    // Intercept stdout to capture logs
    // @ts-ignore
    process.stdout.write = (chunk: string) => {
      try {
        logOutput.push(JSON.parse(chunk));
      } catch (e) {
        // Not JSON, ignore for this test
      }
      return true;
    };
  });

  afterAll(() => {
    process.stdout.write = originalWrite;
  });

  beforeEach(() => {
    logOutput = [];
  });

  it('should output valid JSON', () => {
    logger.info('test message');
    expect(logOutput.length).toBe(1);
    expect(logOutput[0]).toMatchObject({
      level: 'INFO',
      msg: 'test message'
    });
  });

  it('should redact sensitive fields', () => {
    logger.info({ password: 'secret123', token: 'token-456', accountNumber: 'acc-789' }, 'User login');
    expect(logOutput[0].password).toBe('[REDACTED]');
    expect(logOutput[0].token).toBe('[REDACTED]');
    expect(logOutput[0].accountNumber).toBe('[REDACTED]');
  });

  it('should support custom "security" level', () => {
    // @ts-ignore
    logger.security('Potential breach detected');
    expect(logOutput[0].level).toBe('SECURITY');
  });

  it('should support custom "audit" level', () => {
    // @ts-ignore
    logger.audit('Record updated');
    expect(logOutput[0].level).toBe('AUDIT');
  });
});
