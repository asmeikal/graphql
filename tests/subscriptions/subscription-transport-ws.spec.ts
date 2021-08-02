import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { InMemoryCache } from 'apollo-cache-inmemory';
import ApolloClient, { ApolloError } from 'apollo-client';
import { WebSocketLink } from 'apollo-link-ws';
import { gql } from 'apollo-server-express';
import { SubscriptionClient } from 'subscriptions-transport-ws';
import * as ws from 'ws';
import { AppModule } from './app/app.module';
import { pubSub } from './app/notification.resolver';
import { MalformedTokenException } from './utils/malformed-token.exception';
import { MissingAuthorizationException } from './utils/missing-authorization.exception';

const subscriptionQuery = gql`
  subscription TestSubscription($id: String!) {
    newNotification(id: $id) {
      id
      message
    }
  }
`;

describe('subscriptions-transport-ws protocol', () => {
  let app: INestApplication;
  let wsClient: SubscriptionClient;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [
        AppModule.forRoot({
          context: ({ connection }) => {
            return connection?.context ?? {};
          },
          subscriptions: {
            'subscriptions-transport-ws': {
              onConnect: (connectionParams) => {
                if (!connectionParams.authorization) {
                  throw new MissingAuthorizationException();
                }
                const { authorization } = connectionParams;
                if (!authorization.startsWith('Bearer ')) {
                  throw new MalformedTokenException();
                }
                return { user: authorization.split('Bearer ')[1] };
              },
            },
          },
        }),
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
    await app.listen(3001);
  });

  it('should receive an error if missing token', (done) => {
    wsClient = new SubscriptionClient(
      'ws://localhost:3001/graphql',
      {
        connectionCallback: (errors) => {
          const error = errors as unknown as Error;
          expect(error.message).toEqual('Missing authorization');
          done();
        },
        connectionParams: {},
      },
      ws,
    );

    const apolloClient = new ApolloClient({
      link: new WebSocketLink(wsClient),
      cache: new InMemoryCache(),
    });

    apolloClient
      .subscribe({
        query: subscriptionQuery,
        variables: {
          id: '1',
        },
      })
      .subscribe({
        next() {},
        complete() {},
        error() {},
      });
  });

  it('should receive an error if token is malformed', (done) => {
    wsClient = new SubscriptionClient(
      'ws://localhost:3001/graphql',
      {
        connectionCallback: (errors) => {
          const error = errors as unknown as Error;
          expect(error.message).toEqual('Malformed token');
          done();
        },
        connectionParams: {
          authorization: 'wrong token',
        },
      },
      ws,
    );

    const apolloClient = new ApolloClient({
      link: new WebSocketLink(wsClient),
      cache: new InMemoryCache(),
    });

    apolloClient
      .subscribe({
        query: subscriptionQuery,
        variables: {
          id: '1',
        },
      })
      .subscribe({
        next() {},
        complete() {},
        error() {},
      });
  });

  it('should fail to connect if no authorization is provided', (done) => {
    wsClient = new SubscriptionClient(
      'ws://localhost:3001/graphql',
      {
        connectionParams: {
          authorization: 'Bearer notest',
        },
      },
      ws,
    );

    const apolloClient = new ApolloClient({
      link: new WebSocketLink(wsClient),
      cache: new InMemoryCache(),
    });

    apolloClient
      .subscribe({
        query: subscriptionQuery,
        variables: {
          id: '1',
        },
      })
      .subscribe({
        next() {},
        complete() {},
        error(error: unknown) {
          expect(error).toBeInstanceOf(ApolloError);
          expect((error as ApolloError).graphQLErrors[0].message).toEqual(
            'Forbidden resource',
          );
          expect((error as ApolloError).graphQLErrors[0].path[0]).toEqual(
            'newNotification',
          );
          done();
        },
      });
  });

  it('should receive subscriptions', (done) => {
    wsClient = new SubscriptionClient(
      'ws://localhost:3001/graphql',
      {
        connectionParams: {
          authorization: 'Bearer test',
        },
      },
      ws,
    );

    wsClient.on('connected', () => {
      pubSub.publish('newNotification', {
        newNotification: {
          id: '2',
          recipient: 'test',
          message: 'wrong message!',
        },
      });
      pubSub.publish('newNotification', {
        newNotification: {
          id: '1',
          recipient: 'someone-else',
          message: 'wrong message!',
        },
      });
      pubSub.publish('newNotification', {
        newNotification: {
          id: '1',
          recipient: 'test',
          message: 'Hello subscriptions-transport-ws',
        },
      });
    });

    const apolloClient = new ApolloClient({
      link: new WebSocketLink(wsClient),
      cache: new InMemoryCache(),
    });

    apolloClient
      .subscribe({
        query: subscriptionQuery,
        variables: {
          id: '1',
        },
      })
      .subscribe({
        next(value: any) {
          expect(value.data.newNotification.id).toEqual('1');
          expect(value.data.newNotification.message).toEqual(
            'Hello subscriptions-transport-ws',
          );
          done();
        },
        complete() {},
        error(error: unknown) {
          done(error);
        },
      });
  });

  afterEach(async () => {
    await wsClient.close();
    await app.close();
  });
});
