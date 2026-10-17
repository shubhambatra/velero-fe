import { Logger } from '@nestjs/common';
import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';

/**
 * The tracing hook (docs/OBSERVABILITY.md). `withSpan` is always safe to call: with no SDK registered the
 * API hands back a no-op tracer, so nothing is recorded, allocated or exported. `startTracing` is what
 * `OTEL_ENABLED=true` switches on.
 *
 * Span attributes carry ids and enums only (cluster id, operation, status), never payloads, names or
 * credentials, the same rule as the log fields.
 */
const tracer = trace.getTracer('vfm-control-plane');

export function withSpan<T>(
  name: string,
  attributes: Attributes,
  run: () => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await run();
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

interface SdkModule {
  NodeSDK: new (config: { serviceName: string }) => {
    start: () => void;
    shutdown: () => Promise<void>;
  };
}

/** Loads the OpenTelemetry SDK if the operator installed it; says so plainly if not. Returns a shutdown hook. */
export async function startTracing(
  enabled: boolean,
  load: (name: string) => Promise<unknown> = (name) => import(name),
): Promise<() => Promise<void>> {
  const logger = new Logger('Tracing');
  if (!enabled) return () => Promise.resolve();
  try {
    const { NodeSDK } = (await load('@opentelemetry/sdk-node')) as SdkModule;
    const sdk = new NodeSDK({ serviceName: 'vfm-control-plane' });
    sdk.start();
    logger.log('tracing enabled (OTLP, configured by the standard OTEL_* variables)');
    return () => sdk.shutdown();
  } catch {
    logger.warn(
      'OTEL_ENABLED is true but @opentelemetry/sdk-node could not be loaded; tracing stays off. Install it next to the server to use it.',
    );
    return () => Promise.resolve();
  }
}
