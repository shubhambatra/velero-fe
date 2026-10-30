import { ExecutionContext, Injectable } from '@nestjs/common';
import { CacheInterceptor } from '@nestjs/cache-manager';
import { currentKubeContext } from './kube-context';

/** CacheInterceptor whose key includes the cluster context, so clusters never share cached responses. */
@Injectable()
export class ContextCacheInterceptor extends CacheInterceptor {
  protected async trackBy(context: ExecutionContext): Promise<string | undefined> {
    const key = await super.trackBy(context);
    return key === undefined ? key : `${currentKubeContext() ?? ''}|${key}`;
  }
}
