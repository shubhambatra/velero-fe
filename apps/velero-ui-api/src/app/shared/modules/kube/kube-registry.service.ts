import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cluster, Context, KubeConfig, User } from '@kubernetes/client-node';
import { chmodSync, copyFileSync, existsSync, writeFileSync } from 'fs';

export interface KubeContextInfo {
  name: string;
  server: string;
  isDefault: boolean;
}

/**
 * The clusters the UI can manage: the contexts of one managed kubeconfig file (KUBE_CONFIG_PATH),
 * or the single in-cluster service account when no file is configured. A fresh KubeConfig is
 * built per context because setCurrentContext is global to a KubeConfig instance.
 */
@Injectable()
export class KubeRegistry {
  private readonly base = new KubeConfig();
  private readonly file: string | undefined;
  private readonly perContext = new Map<string, KubeConfig>();
  private defaultName: string;

  constructor(config: ConfigService) {
    this.file = config.get<string>('k8s.configPath');

    if (!this.file) {
      this.base.loadFromCluster();
      this.defaultName = this.base.getCurrentContext();
      return;
    }

    const seed = config.get<string>('k8s.seedPath');
    if (!existsSync(this.file) && seed && existsSync(seed)) {
      // First start: copy the host kubeconfig so the original is never modified.
      copyFileSync(seed, this.file);
      chmodSync(this.file, 0o600);
    }
    if (!existsSync(this.file)) {
      throw new Error(
        `Cannot read kubeconfig at "${this.file}" (KUBE_CONFIG_PATH). Verify the file exists and is mounted correctly.`
      );
    }
    this.base.loadFromFile(this.file);

    const wanted = config.get<string>('k8s.context');
    const names = this.names();
    if (wanted && !names.includes(wanted)) {
      throw new Error(
        `KUBE_CONTEXT "${wanted}" was not found in "${this.file}". Available contexts: ${
          names.join(', ') || 'none'
        }.`
      );
    }
    this.defaultName = wanted ?? this.base.getCurrentContext() ?? names[0];
  }

  public names(): string[] {
    return this.base.getContexts().map((c) => c.name);
  }

  public list(): KubeContextInfo[] {
    return this.base.getContexts().map((c) => ({
      name: c.name,
      server: this.base.getCluster(c.cluster)?.server ?? '',
      isDefault: c.name === this.defaultName,
    }));
  }

  public get managed(): boolean {
    return this.file !== undefined;
  }

  /** KubeConfig of a context (the default one when omitted); unknown names are rejected. */
  public get(name?: string): KubeConfig {
    const context = name ?? this.defaultName;
    if (!this.file) {
      return this.base;
    }
    const cached = this.perContext.get(context);
    if (cached) {
      return cached;
    }
    if (!this.names().includes(context)) {
      throw new BadRequestException(`Unknown cluster context "${context}"`);
    }
    const kc = new KubeConfig();
    kc.loadFromOptions({
      clusters: this.base.getClusters(),
      users: this.base.getUsers(),
      contexts: this.base.getContexts(),
      currentContext: context,
    });
    this.perContext.set(context, kc);
    return kc;
  }

  /** Adds every context of a pasted kubeconfig; returns the added context names. */
  public add(kubeconfig: string): string[] {
    this.requireManaged();
    const incoming = new KubeConfig();
    try {
      incoming.loadFromString(kubeconfig);
    } catch {
      throw new BadRequestException('The kubeconfig could not be parsed');
    }
    const contexts = incoming.getContexts();
    if (contexts.length === 0) {
      throw new BadRequestException('The kubeconfig contains no contexts');
    }

    const clusters: Cluster[] = [];
    const users: User[] = [];
    const added: Context[] = [];
    for (const ctx of contexts) {
      if (this.names().includes(ctx.name)) {
        throw new ConflictException(`Cluster context "${ctx.name}" already exists`);
      }
      const cluster = incoming.getCluster(ctx.cluster);
      const user = incoming.getUser(ctx.user);
      if (!cluster || !user) {
        throw new BadRequestException(`Context "${ctx.name}" references a missing cluster or user`);
      }
      this.validate(ctx.name, cluster, user);
      // One cluster and user entry per context, named after it, so removal is clean.
      clusters.push({ ...cluster, name: ctx.name });
      users.push({ ...user, name: ctx.name });
      added.push({ name: ctx.name, cluster: ctx.name, user: ctx.name });
    }

    this.persist({
      clusters: [...this.base.getClusters(), ...clusters],
      users: [...this.base.getUsers(), ...users],
      contexts: [...this.base.getContexts(), ...added],
    });
    return added.map((c) => c.name);
  }

  public remove(name: string): void {
    this.requireManaged();
    if (!this.names().includes(name)) {
      throw new NotFoundException(`Unknown cluster context "${name}"`);
    }
    const contexts = this.base.getContexts().filter((c) => c.name !== name);
    this.persist({
      clusters: this.base.getClusters().filter((c) => contexts.some((x) => x.cluster === c.name)),
      users: this.base.getUsers().filter((u) => contexts.some((x) => x.user === u.name)),
      contexts,
    });
  }

  private requireManaged(): void {
    if (!this.file) {
      throw new BadRequestException(
        'Adding or removing clusters needs a managed kubeconfig (set KUBE_CONFIG_PATH)'
      );
    }
  }

  /** Rejects anything that would run local commands or read local files on the server. */
  private validate(name: string, cluster: Cluster, user: User): void {
    if (!/^https?:\/\//.test(cluster.server ?? '')) {
      throw new BadRequestException(`Context "${name}": the cluster server must be an http(s) URL`);
    }
    if (user.exec || user.authProvider) {
      throw new BadRequestException(
        `Context "${name}": exec and auth-provider credentials are not accepted; use a token or client certificate`
      );
    }
    if (cluster.caFile || user.certFile || user.keyFile || (user as { tokenFile?: string }).tokenFile) {
      throw new BadRequestException(
        `Context "${name}": credentials must be embedded (…-data fields), not file paths`
      );
    }
  }

  private persist(next: { clusters: Cluster[]; users: User[]; contexts: Context[] }): void {
    const currentContext =
      next.contexts.find((c) => c.name === this.defaultName)?.name ?? next.contexts[0]?.name;
    this.base.loadFromOptions({ ...next, currentContext });
    writeFileSync(this.file as string, this.base.exportConfig(), { mode: 0o600 });
    // `mode` only applies when the file is created; tighten a pre-existing file too.
    chmodSync(this.file as string, 0o600);
    this.perContext.clear();
    this.defaultName = currentContext ?? '';
  }
}
