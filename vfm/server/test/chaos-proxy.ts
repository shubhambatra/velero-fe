import { createServer, connect, type Server, type Socket } from 'node:net';

/**
 * A TCP proxy that can be cut and restored, standing in for a database restart or a network partition
 * without needing root or docker: `cut()` resets every open connection and refuses new ones until
 * `restore()`. Bytes are passed through untouched, so TLS (the agent link) and the Postgres and Redis
 * protocols all work through it.
 */
export class ChaosProxy {
  private readonly sockets = new Set<Socket>();
  private cutOff = false;
  private constructor(
    private readonly server: Server,
    readonly port: number,
  ) {}

  static async start(host: string, port: number): Promise<ChaosProxy> {
    const sockets = new Set<Socket>();
    const holder: { proxy?: ChaosProxy } = {};
    const server = createServer((client) => {
      if (holder.proxy?.cutOff === true) {
        client.destroy();
        return;
      }
      const upstream = connect({ host, port });
      for (const s of [client, upstream]) {
        sockets.add(s);
        holder.proxy?.sockets.add(s);
        s.on('close', () => {
          sockets.delete(s);
          holder.proxy?.sockets.delete(s);
        });
        s.on('error', () => s.destroy());
      }
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no proxy port');
    holder.proxy = new ChaosProxy(server, address.port);
    return holder.proxy;
  }

  cut(): void {
    this.cutOff = true;
    for (const s of [...this.sockets]) s.destroy();
  }

  restore(): void {
    this.cutOff = false;
  }

  async close(): Promise<void> {
    this.cut();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }
}
