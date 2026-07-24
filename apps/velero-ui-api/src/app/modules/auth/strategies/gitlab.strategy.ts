import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { Strategy } from 'passport-gitlab2';
import { AppLogger } from '@velero-ui-api/shared/modules/logger/logger.service';
import { AuthenticationException } from '@velero-ui-api/shared/exceptions/authentication.exception';
import { HttpService } from '@nestjs/axios';
import { catchError, lastValueFrom, of, mergeMap, expand, EMPTY, toArray } from 'rxjs';

const GITLAB_ACCESS_LEVELS: Record<number, string> = {
  10: 'guest',
  20: 'reporter',
  30: 'developer',
  40: 'maintainer',
  50: 'owner',
};

@Injectable()
export class GitlabStrategy extends PassportStrategy(Strategy, 'gitlab') {
  constructor(
    private logger: AppLogger,
    private readonly configService: ConfigService,
    private readonly httpService: HttpService
  ) {
    super({
      clientID: configService.get('gitlab.clientId') || ' ',
      clientSecret: configService.get('gitlab.clientSecret'),
      scope: configService.get('gitlab.scopes'),
      callbackURL: configService.get('gitlab.redirectUri'),
      baseURL: configService.get('gitlab.baseUrl'),
      searchTerm: configService.get('gitlab.searchTerm'),
    });
  }

  public async validate(
    accessToken: string,
    refreshToken: string,
    profile: any
  ) {
    const { emails, avatarUrl, id, provider, displayName } = profile;

    if (!profile) {
      throw new AuthenticationException('Invalid User', {
        cause: GitlabStrategy.name,
      });
    }

    const groups: string[] = [];

    if (
      this.configService
        .get<string>('gitlab.scopes')
        .includes('read_api')
    ) {

      const groupsWithRoles = await lastValueFrom(
        this.getUserGroupsWithRoles(accessToken)
      );

      for (const group of groupsWithRoles) {
        groups.push(group.fullPath);
        if (group.accessLevel !== 'unknown') {
          groups.push(`${ group.fullPath }:${ group.accessLevel }`);
        }
      }
    }

    this.logger.info(
      `Federated Gitlab user ${id} signed in.`,
      GitlabStrategy.name
    );

    this.logger.debug(
      `User ${id} belongs to groups: ${groups.join(', ')}`,
      GitlabStrategy.name
    );

    return {
      id,
      provider,
      displayName,
      email: emails[0].value,
      picture: avatarUrl,
      policy: {
        user: emails[0].value,
        groups,
      },
    };
  }

  private getUserGroupsWithRoles(accessToken: string) {
    const baseUrl = this.configService.get('gitlab.baseUrl');
    const searchTerm = this.configService.get('gitlab.searchTerm');

    const createUrl = (page: number) => {
      const url = new URL('/api/v4/groups', baseUrl);
      url.searchParams.append('page', page.toString());
      url.searchParams.append('per_page', '100');
      if (searchTerm) url.searchParams.append('search', searchTerm);

      this.logger.debug(
        `Url created: ${url.toString()}`,
        GitlabStrategy.name
      );

      return url.toString();
    };

    return this.httpService
      .get(createUrl(1), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      })
      .pipe(
        expand((response) => {
          const currentPage = parseInt(response.headers['x-page'] || '1');
          const totalPages = parseInt(response.headers['x-total-pages'] || '1');

          if (currentPage < totalPages) {
            return this.httpService.get(createUrl(currentPage + 1), {
              headers: {
                Authorization: `Bearer ${accessToken}`,
              },
            });
          }
          return EMPTY;
        }),
        mergeMap((res) =>
          res.data.map((group) => ({
            id: group.id,
            name: group.name,
            fullPath: group.full_path,
            accessLevel:
              GITLAB_ACCESS_LEVELS[
              group.permissions?.group_access?.access_level
              ] || 'unknown',
          }))
        ),
        toArray(),
        catchError((err) => {
          console.warn(
            'GitLab API error: ' + err.response?.data || err.message,
            GitlabStrategy.name
          );
          return of([]);
        })
      );
  }
}
