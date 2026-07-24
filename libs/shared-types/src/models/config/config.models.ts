export enum Environment {
  DEVELOPMENT = 'development',
  PRODUCTION = 'production',
}

export interface AppPublicConfig extends Pick<
  AppConfig,
  'language' | 'timezone' | 'timeFormat24h' | 'baseUrl' | 'grafanaUrl'
> {
  noAuthRequired: boolean;
  basicAuth: Pick<BasicAuthConfig, 'enabled'>;
  google: Pick<GoogleConfig, 'enabled' | 'scopes' | 'clientId' | 'redirectUri'>;
  github: Pick<GithubConfig, 'enabled' | 'scopes' | 'clientId' | 'redirectUri'>;
  gitlab: Pick<
    GitlabConfig,
    'enabled' | 'scopes' | 'clientId' | 'redirectUri' | 'baseUrl'
  >;
  microsoft: Pick<
    MicrosoftConfig,
    | 'enabled'
    | 'scopes'
    | 'clientId'
    | 'redirectUri'
    | 'tenant'
    | 'authorizationUrl'
  >;
  oauth: Pick<
    OauthConfig,
    | 'enabled'
    | 'scopes'
    | 'clientId'
    | 'redirectUri'
    | 'name'
    | 'authorizationUrl'
  >;
  language: string;
  timezone: string;
  timeFormat24h: boolean;
}

export interface AppConfig {
  environment: Environment;
  grafanaUrl?: string;
  baseUrl: string;
  logLevel: string;
  secret?: string;
  sessionDuration?: string;
  namespace?: string;
  policyPath?: string;
  cacheTTL: number;
  language: string;
  timezone: string;
  timeFormat24h: boolean;
}

export interface LDAPConfig {
  enabled: boolean;
  url: string;
  bindDn: string;
  bindCredentials: string;
  searchBase: string;
  searchFilter: string;
  searchAttributes: string;
  groupSearchBase: string;
}

export interface BasicAuthConfig {
  enabled: boolean;
  username: string;
  password: string;
}

export interface GoogleConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUri: string;
}

export interface GithubConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUri: string;
}

export interface MicrosoftConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUri: string;
  tenant: string;
  authorizationUrl: string;
  tokenUrl: string;
}

export interface GitlabConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUri: string;
  baseUrl: string;
}

export interface OauthConfig {
  enabled: boolean;
  name: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUri: string;
  tokenUrl: string;
  authorizationUrl: string;
  userInfoUrl: string;
  groupClaim?: string;
}

export interface VeleroConfig {
  namespace: string;
}

export interface K8sConfig {
  configPath: string;
  context: string;
}
