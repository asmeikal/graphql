import { Type } from '@nestjs/common';
import { ModuleMetadata } from '@nestjs/common/interfaces';
import { Config, GraphQLExecutor } from 'apollo-server-core';
import { GraphQLSchema } from 'graphql';
import { DefinitionsGeneratorOptions } from '../graphql-ast.explorer';
import { BuildSchemaOptions } from './build-schema-options.interface';
import { Context } from 'graphql-ws';
import { IncomingMessage } from 'http';
import * as ws from 'ws';
import { ConnectionContext } from 'subscriptions-transport-ws';

export interface ServerRegistration {
  path?: string;
  cors?: any | boolean;
  bodyParserConfig?: any | boolean;
  onHealthCheck?: (req: any) => Promise<any>;
  disableHealthCheck?: boolean;
}

export interface IResolverValidationOptions {
  requireResolversForArgs?: boolean;
  requireResolversForNonScalar?: boolean;
  requireResolversForAllFields?: boolean;
  requireResolversForResolveType?: boolean;
  allowResolversNotInSchema?: boolean;
}

export type Omit<T, K> = Pick<T, Exclude<keyof T, K>>;

export type DefaultSubscriptionsConfig = Config['subscriptions'];

type WebSocket = typeof ws.prototype;

export type GraphqlWsContextExtra = {
  readonly socket: WebSocket;
  readonly request: IncomingMessage;
};

export type SubscriptionTransportWsOnConnectOptions = [Object, WebSocket, ConnectionContext];

export type GraphQLWsOnConnectOptions = [Context<GraphqlWsContextExtra>];

export type SubscriptionTransportWsOnDisconnectOptions = [WebSocket, ConnectionContext];

export type GraphQLWsOnDisconnectOptions = [Context<GraphqlWsContextExtra>, number, string];

export interface SubscriptionConfig {
  path?: string;
  connectonInitWaitTimeout?: number;
  keepAlive?: number;
  onConnect?: (...args: SubscriptionTransportWsOnConnectOptions | GraphQLWsOnConnectOptions) => any;
  onDisconnect?: (...args: SubscriptionTransportWsOnDisconnectOptions | GraphQLWsOnDisconnectOptions) => any;
}

export type Enhancer = 'guards' | 'interceptors' | 'filters';
export interface GqlModuleOptions
  extends Omit<Config, 'typeDefs' | 'subscriptions'>,
    Partial<
      Pick<
        ServerRegistration,
        | 'onHealthCheck'
        | 'disableHealthCheck'
        | 'path'
        | 'cors'
        | 'bodyParserConfig'
      >
    > {
  typeDefs?: string | string[];
  typePaths?: string[];
  include?: Function[];
  executorFactory?: (
    schema: GraphQLSchema,
  ) => GraphQLExecutor | Promise<GraphQLExecutor>;
  installSubscriptionHandlers?: boolean;
  subscriptions?: SubscriptionConfig | false;
  resolverValidationOptions?: IResolverValidationOptions;
  directiveResolvers?: any;
  schemaDirectives?: Record<string, any>;
  transformSchema?: (
    schema: GraphQLSchema,
  ) => GraphQLSchema | Promise<GraphQLSchema>;
  definitions?: {
    path?: string;
    outputAs?: 'class' | 'interface';
  } & DefinitionsGeneratorOptions;
  autoSchemaFile?: string | boolean;
  buildSchemaOptions?: BuildSchemaOptions;
  /**
   * Prepends the global prefix to the url
   *
   * @see [faq/global-prefix](Global Prefix)
   */
  useGlobalPrefix?: boolean;
  /**
   * Enable/disable enhancers for @ResolveField()
   */
  fieldResolverEnhancers?: Enhancer[];
  /**
   * Sort the schema lexicographically
   */
  sortSchema?: boolean;
  /**
   * Apply `transformSchema` to the `autoSchemaFile`
   */
  transformAutoSchemaFile?: boolean;
}

export interface GqlOptionsFactory {
  createGqlOptions(): Promise<GqlModuleOptions> | GqlModuleOptions;
}

export interface GqlModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useExisting?: Type<GqlOptionsFactory>;
  useClass?: Type<GqlOptionsFactory>;
  useFactory?: (...args: any[]) => Promise<GqlModuleOptions> | GqlModuleOptions;
  inject?: any[];
}
