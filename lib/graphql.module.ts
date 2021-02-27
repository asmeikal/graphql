import { Inject, Module } from '@nestjs/common';
import {
  DynamicModule,
  OnModuleDestroy,
  OnModuleInit,
  Provider,
} from '@nestjs/common/interfaces';
import { loadPackage } from '@nestjs/common/utils/load-package.util';
import { ApplicationConfig, HttpAdapterHost } from '@nestjs/core';
import { MetadataScanner } from '@nestjs/core/metadata-scanner';
import { ApolloServerBase } from 'apollo-server-core';
import { execute, ExecutionResult, printSchema, subscribe } from 'graphql';
import { GraphQLAstExplorer } from './graphql-ast.explorer';
import { GraphQLSchemaBuilder } from './graphql-schema.builder';
import { GraphQLSchemaHost } from './graphql-schema.host';
import { GraphQLTypesLoader } from './graphql-types.loader';
import { GRAPHQL_MODULE_ID, GRAPHQL_MODULE_OPTIONS } from './graphql.constants';
import { GraphQLFactory } from './graphql.factory';
import {
  GqlModuleAsyncOptions,
  GqlModuleOptions,
  GqlOptionsFactory,
} from './interfaces/gql-module-options.interface';
import { GraphQLSchemaBuilderModule } from './schema-builder/schema-builder.module';
import {
  PluginsExplorerService,
  ResolversExplorerService,
  ScalarsExplorerService,
} from './services';
import {
  extend,
  generateString,
  mergeDefaults,
  normalizeRoutePath,
} from './utils';
import { GraphqlWsSubscriptionService } from './graphql-ws/graphql-ws-subscription.service';
import * as ws from 'ws';
import {
  ExecutionParams,
  SubscriptionServer,
} from 'subscriptions-transport-ws';
import { formatApolloErrors } from 'apollo-server-errors';
import { Context } from 'apollo-server-core/src/types';

@Module({
  imports: [GraphQLSchemaBuilderModule],
  providers: [
    GraphQLFactory,
    MetadataScanner,
    ResolversExplorerService,
    ScalarsExplorerService,
    PluginsExplorerService,
    GraphQLAstExplorer,
    GraphQLTypesLoader,
    GraphQLSchemaBuilder,
    GraphQLSchemaHost,
  ],
  exports: [GraphQLTypesLoader, GraphQLAstExplorer, GraphQLSchemaHost],
})
export class GraphQLModule implements OnModuleInit, OnModuleDestroy {
  private _apolloServer: ApolloServerBase;
  private _graphQlWsServer?: GraphqlWsSubscriptionService;
  private _subscriptionTransportWsServer?: SubscriptionServer;

  get apolloServer(): ApolloServerBase {
    return this._apolloServer;
  }

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    @Inject(GRAPHQL_MODULE_OPTIONS) private readonly options: GqlModuleOptions,
    private readonly graphqlFactory: GraphQLFactory,
    private readonly graphqlTypesLoader: GraphQLTypesLoader,
    private readonly applicationConfig: ApplicationConfig,
  ) {}

  static forRoot(options: GqlModuleOptions = {}): DynamicModule {
    options = mergeDefaults(options);
    return {
      module: GraphQLModule,
      providers: [
        {
          provide: GRAPHQL_MODULE_OPTIONS,
          useValue: options,
        },
      ],
    };
  }

  static forRootAsync(options: GqlModuleAsyncOptions): DynamicModule {
    return {
      module: GraphQLModule,
      imports: options.imports,
      providers: [
        ...this.createAsyncProviders(options),
        {
          provide: GRAPHQL_MODULE_ID,
          useValue: generateString(),
        },
      ],
    };
  }

  private static createAsyncProviders(
    options: GqlModuleAsyncOptions,
  ): Provider[] {
    if (options.useExisting || options.useFactory) {
      return [this.createAsyncOptionsProvider(options)];
    }
    return [
      this.createAsyncOptionsProvider(options),
      {
        provide: options.useClass,
        useClass: options.useClass,
      },
    ];
  }

  private static createAsyncOptionsProvider(
    options: GqlModuleAsyncOptions,
  ): Provider {
    if (options.useFactory) {
      return {
        provide: GRAPHQL_MODULE_OPTIONS,
        useFactory: async (...args: any[]) =>
          mergeDefaults(await options.useFactory(...args)),
        inject: options.inject || [],
      };
    }
    return {
      provide: GRAPHQL_MODULE_OPTIONS,
      useFactory: async (optionsFactory: GqlOptionsFactory) =>
        mergeDefaults(await optionsFactory.createGqlOptions()),
      inject: [options.useExisting || options.useClass],
    };
  }

  async onModuleInit() {
    if (!this.httpAdapterHost) {
      return;
    }
    const httpAdapter = this.httpAdapterHost.httpAdapter;
    if (!httpAdapter) {
      return;
    }
    const typeDefs =
      (await this.graphqlTypesLoader.mergeTypesByPaths(
        this.options.typePaths,
      )) || [];

    const mergedTypeDefs = extend(typeDefs, this.options.typeDefs);
    const apolloOptions = await this.graphqlFactory.mergeOptions({
      ...this.options,
      typeDefs: mergedTypeDefs,
    });
    await this.runExecutorFactoryIfPresent(apolloOptions);

    if (this.options.definitions && this.options.definitions.path) {
      await this.graphqlFactory.generateDefinitions(
        printSchema(apolloOptions.schema),
        this.options,
      );
    }

    await this.registerGqlServer(apolloOptions);
    if (this.options.installSubscriptionHandlers && this.options.subscriptions) {
      const graphqlWs = new ws.Server({ noServer: true });
      const subTransWs = new ws.Server({ noServer: true });

      this._graphQlWsServer = new GraphqlWsSubscriptionService(
        {
          schema: apolloOptions.schema,
          keepAlive: this.options.subscriptions.keepAlive,
          context: this.options.context,
          onConnect: this.options.subscriptions.onConnect as any,
          onDisconnect: this.options.subscriptions.onDisconnect as any,
        },
        graphqlWs,
      );

      this._subscriptionTransportWsServer = SubscriptionServer.create(
        {
          schema: apolloOptions.schema,
          execute,
          subscribe,
          onConnect: this.options.subscriptions.onConnect
            ? this.options.subscriptions.onConnect
            : (connectionParams: Object) => ({ ...connectionParams }),
          onDisconnect: this.options.subscriptions.onDisconnect,
          onOperation: async (
            message: { payload: any },
            connection: ExecutionParams,
          ) => {
            connection.formatResponse = (value: ExecutionResult) => ({
              ...value,
              errors:
                value.errors &&
                formatApolloErrors([...value.errors], {
                  formatter: apolloOptions.formatError,
                  debug: apolloOptions.debug,
                }),
            });

            connection.formatError = apolloOptions.formatError;

            let context: Context = apolloOptions.context ? apolloOptions.context : { connection };

            try {
              context =
                typeof apolloOptions.context === 'function'
                  ? await apolloOptions.context({ connection, payload: message.payload })
                  : context;
            } catch (e) {
              throw formatApolloErrors([e], {
                formatter: apolloOptions.formatError,
                debug: apolloOptions.debug,
              })[0];
            }

            return { ...connection, context };
          },
          keepAlive: this.options.subscriptions.keepAlive,
          validationRules: apolloOptions.validationRules
        },
        subTransWs
      );
      this._apolloServer.installSubscriptionHandlers(subTransWs);

      httpAdapter.getHttpServer().on('upgrade', (req, socket, head) => {
        const protocol = req.headers['sec-websocket-protocol'];
        const protocols = Array.isArray(protocol)
          ? protocol
          : protocol?.split(',').map((p) => p.trim());

        const wss =
          protocols?.includes('graphql-ws') &&
          !protocols.includes('graphql-transport-ws')
            ? subTransWs
            : graphqlWs;

        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req);
        });
      });
    }
  }

  async onModuleDestroy() {
    await this._graphQlWsServer?.stop();
    await this._subscriptionTransportWsServer?.close();
    await this._apolloServer?.stop();
  }

  private async registerGqlServer(apolloOptions: GqlModuleOptions) {
    const httpAdapter = this.httpAdapterHost.httpAdapter;
    const platformName = httpAdapter.getType();

    if (platformName === 'express') {
      this.registerExpress(apolloOptions);
    } else if (platformName === 'fastify') {
      await this.registerFastify(apolloOptions);
    } else {
      throw new Error(`No support for current HttpAdapter: ${platformName}`);
    }
  }

  private registerExpress(apolloOptions: GqlModuleOptions) {
    const { ApolloServer } = loadPackage(
      'apollo-server-express',
      'GraphQLModule',
      () => require('apollo-server-express'),
    );
    const path = this.getNormalizedPath(apolloOptions);
    const {
      disableHealthCheck,
      onHealthCheck,
      cors,
      bodyParserConfig,
    } = this.options;

    const httpAdapter = this.httpAdapterHost.httpAdapter;
    const app = httpAdapter.getInstance();
    const apolloServer = new ApolloServer(apolloOptions as any);

    apolloServer.applyMiddleware({
      app,
      path,
      disableHealthCheck,
      onHealthCheck,
      cors,
      bodyParserConfig,
    });

    this._apolloServer = apolloServer;
  }

  private async registerFastify(apolloOptions: GqlModuleOptions) {
    const { ApolloServer } = loadPackage(
      'apollo-server-fastify',
      'GraphQLModule',
      () => require('apollo-server-fastify'),
    );

    const httpAdapter = this.httpAdapterHost.httpAdapter;
    const app = httpAdapter.getInstance();
    const path = this.getNormalizedPath(apolloOptions);

    const apolloServer = new ApolloServer(apolloOptions as any);
    const {
      disableHealthCheck,
      onHealthCheck,
      cors,
      bodyParserConfig,
    } = this.options;

    await app.register(
      apolloServer.createHandler({
        disableHealthCheck,
        onHealthCheck,
        cors,
        bodyParserConfig,
        path,
      }),
    );

    this._apolloServer = apolloServer;
  }

  private getNormalizedPath(apolloOptions: GqlModuleOptions): string {
    const prefix = this.applicationConfig.getGlobalPrefix();
    const useGlobalPrefix = prefix && this.options.useGlobalPrefix;
    const gqlOptionsPath = normalizeRoutePath(apolloOptions.path);
    return useGlobalPrefix
      ? normalizeRoutePath(prefix) + gqlOptionsPath
      : gqlOptionsPath;
  }

  private async runExecutorFactoryIfPresent(apolloOptions: GqlModuleOptions) {
    if (!apolloOptions.executorFactory) {
      return;
    }
    const executor = await apolloOptions.executorFactory(apolloOptions.schema);
    apolloOptions.executor = executor;
  }
}
