import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  UnauthorizedException,
} from '@nestjs/common';
import {
  experimental,
  Server,
  status,
  type ServerUnaryCall,
  type ServiceError,
  type sendUnaryData,
  type ServerDuplexStream,
} from '@grpc/grpc-js';

import { CaService } from '../ca/ca.service';
import { EnrollmentService } from '../clusters/enrollment.service';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { GatewayIdentityProvider } from './gateway-identity';
import {
  AgentGatewayService,
  type AgentMessage,
  type ServerMessage,
} from './pb/vfm/agent/v1/gateway';
import {
  EnrollResponse,
  RenewCertificateResponse,
  type EnrollRequest,
  type RenewCertificateRequest,
} from './pb/vfm/agent/v1/enrollment';

/** PLAN.md §5.6. */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
/** Re-issue the gateway's own certificate when it has less than this left. */
const SERVER_CERT_RENEW_BEFORE_MS = 10 * 24 * 3_600_000;
const SERVER_CERT_CHECK_INTERVAL_MS = 3_600_000;

const MAX_TOKEN = 256;
const MAX_CSR = 8 * 1024;
const MAX_SHORT = 256;

/** Maps what the services throw onto gRPC statuses without leaking internals. */
function toServiceError(error: unknown, logger: Logger): Partial<ServiceError> {
  if (error instanceof UnauthorizedException) {
    return { code: status.UNAUTHENTICATED, details: error.message };
  }
  if (error instanceof BadRequestException) {
    return { code: status.INVALID_ARGUMENT, details: error.message };
  }
  if (error instanceof ConflictException) {
    return { code: status.FAILED_PRECONDITION, details: error.message };
  }
  logger.error(`gateway handler failed: ${error instanceof Error ? error.message : 'unknown'}`);
  return { code: status.INTERNAL, details: 'internal error' };
}

/**
 * The agent gateway (PLAN.md §5, §10): the gRPC listener agents dial.
 *
 * One port carries all three RPCs. The listener *asks* for a client certificate
 * and verifies it against the internal CA, but does not require one, because
 * `Enroll` is the call that obtains the first certificate. Requiring a
 * certificate is therefore enforced per RPC: `RenewCertificate` and `Connect`
 * refuse a caller without a verified, unrevoked certificate.
 */
@Injectable()
export class GatewayService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(GatewayService.name);
  private readonly identity = new GatewayIdentityProvider();
  private server: Server | undefined;
  private rotation: NodeJS.Timeout | undefined;
  private serverCertNotAfter = new Date(0);
  private port = 0;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly ca: CaService,
    private readonly enrollment: EnrollmentService,
  ) {}

  /** The port actually bound; differs from `GATEWAY_PORT` only when that is 0. */
  get boundPort(): number {
    return this.port;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.env.GATEWAY_ENABLED) {
      this.logger.log('agent gateway disabled (GATEWAY_ENABLED=false)');
      return;
    }

    await this.rotateServerCertificate();
    this.rotation = setInterval(() => {
      if (this.serverCertNotAfter.getTime() - Date.now() < SERVER_CERT_RENEW_BEFORE_MS) {
        this.rotateServerCertificate().catch((error: unknown) => {
          this.logger.error(
            `could not renew the gateway certificate: ${error instanceof Error ? error.message : 'unknown'}`,
          );
        });
      }
    }, SERVER_CERT_CHECK_INTERVAL_MS);
    this.rotation.unref();

    const server = new Server({
      'grpc.max_receive_message_length': MAX_MESSAGE_BYTES,
      'grpc.max_send_message_length': MAX_MESSAGE_BYTES,
    });
    server.addService(AgentGatewayService, {
      enroll: (
        call: ServerUnaryCall<EnrollRequest, EnrollResponse>,
        cb: sendUnaryData<EnrollResponse>,
      ) => {
        this.handle(cb, () => this.enroll(call.request));
      },
      renewCertificate: (
        call: ServerUnaryCall<RenewCertificateRequest, RenewCertificateResponse>,
        cb: sendUnaryData<RenewCertificateResponse>,
      ) => {
        this.handle(cb, () => this.renew(call));
      },
      connect: (call: ServerDuplexStream<AgentMessage, ServerMessage>) => {
        this.connect(call).catch((error: unknown) => {
          call.emit('error', toServiceError(error, this.logger));
        });
      },
    });

    const credentials = experimental.createCertificateProviderServerCredentials(
      this.identity,
      this.identity,
      false,
    );

    this.port = await new Promise<number>((resolve, reject) => {
      server.bindAsync(
        `${this.env.HOST}:${this.env.GATEWAY_PORT.toString()}`,
        credentials,
        (error, port) => {
          if (error !== null) {
            reject(error);
          } else {
            resolve(port);
          }
        },
      );
    });
    this.server = server;
    this.logger.log(`agent gateway listening on ${this.env.HOST}:${this.port.toString()} (mTLS)`);
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.rotation !== undefined) {
      clearInterval(this.rotation);
    }
    const server = this.server;
    if (server === undefined) {
      return;
    }
    // Streams are long-lived, so a graceful drain would wait forever.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        server.forceShutdown();
        resolve();
      }, 5_000);
      timer.unref();
      server.tryShutdown(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Issues a new TLS identity and swaps it in without dropping the listener. */
  async rotateServerCertificate(): Promise<void> {
    const issued = await this.ca.issueServerCertificate(this.env.GATEWAY_HOSTNAMES);
    this.serverCertNotAfter = issued.notAfter;
    this.identity.set(issued, await this.ca.certificatePem());
  }

  private handle<T>(callback: sendUnaryData<T>, run: () => Promise<T>): void {
    run().then(
      (value) => {
        callback(null, value);
      },
      (error: unknown) => {
        callback(toServiceError(error, this.logger), null);
      },
    );
  }

  private async enroll(request: EnrollRequest): Promise<EnrollResponse> {
    if (
      request.bootstrapToken.length > MAX_TOKEN ||
      request.csrPem.length > MAX_CSR ||
      request.clusterFingerprint.length > MAX_SHORT ||
      request.agentVersion.length > MAX_SHORT
    ) {
      throw new BadRequestException('request field too large');
    }
    const result = await this.enrollment.enroll({
      token: request.bootstrapToken,
      csrPem: Buffer.from(request.csrPem).toString('utf8'),
      clusterFingerprint: request.clusterFingerprint,
      agentVersion: request.agentVersion,
    });
    return EnrollResponse.fromPartial({
      clusterId: result.clusterId,
      certificatePem: Buffer.from(result.certificatePem),
      caBundlePem: Buffer.from(result.caBundlePem),
      notAfter: result.notAfter,
    });
  }

  private async renew(
    call: ServerUnaryCall<RenewCertificateRequest, RenewCertificateResponse>,
  ): Promise<RenewCertificateResponse> {
    if (call.request.csrPem.length > MAX_CSR) {
      throw new BadRequestException('request field too large');
    }
    const result = await this.enrollment.renew(
      this.peerCertificate(call),
      Buffer.from(call.request.csrPem).toString('utf8'),
    );
    return RenewCertificateResponse.fromPartial({
      certificatePem: Buffer.from(result.certificatePem),
      caBundlePem: Buffer.from(result.caBundlePem),
      notAfter: result.notAfter,
    });
  }

  /**
   * Authenticates the stream's certificate. The stream itself arrives with the
   * connection manager and routing (day 13); until then an authenticated agent is
   * told so, and an unauthenticated one is refused exactly as it will be later.
   */
  private async connect(call: ServerDuplexStream<AgentMessage, ServerMessage>): Promise<void> {
    await this.enrollment.authenticate(this.peerCertificate(call));
    call.emit('error', {
      code: status.UNIMPLEMENTED,
      details: 'the agent stream is not implemented yet',
    });
  }

  /** The verified client certificate (DER), or a refusal. */
  private peerCertificate(call: {
    getAuthContext: () => { sslPeerCertificate?: { raw?: Buffer } };
  }): Buffer {
    const raw = call.getAuthContext().sslPeerCertificate?.raw;
    if (raw === undefined || raw.length === 0) {
      // No certificate, or one that did not verify against the internal CA:
      // grpc-js reports neither as an auth context.
      throw new UnauthorizedException('a client certificate is required');
    }
    return raw;
  }
}
