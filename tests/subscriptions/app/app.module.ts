import { Module } from '@nestjs/common';
import { NotificationModule } from './notification.module';
import { GraphQLModule } from '../../../lib';
import { Context } from 'graphql-ws';
import { MissingAuthorizationException } from '../utils/missing-authorization.exception';
import { MalformedTokenException } from '../utils/malformed-token.exception';

@Module({
  imports: [
    NotificationModule,
    GraphQLModule.forRoot({
      debug: false,
      context: (firstArg) => {
        if (firstArg?.connection?.context) {
          return firstArg.connection.context ?? {};
        } else if (firstArg?.connectionParams) {
          const { authorization } = firstArg?.connectionParams ?? {};
          if (authorization) {
            return { user: (authorization as string).split('Bearer ')[1] };
          } else {
            return {};
          }
        } else {
          return {};
        }
      },
      autoSchemaFile: true,
      installSubscriptionHandlers: true,
      subscriptions: {
        onConnect: (firstArg, ...rest) => {
          if ('connectionParams' in firstArg) {
            const context = firstArg as Context;
            if (!context.connectionParams.authorization) {
              throw new MissingAuthorizationException();
            }
            const authorization = context.connectionParams
              .authorization as string;
            if (!authorization.startsWith('Bearer ')) {
              throw new MalformedTokenException();
            }
            return true;
          } else {
            const connectionParams = firstArg as any;
            if (!connectionParams.authorization) {
              throw new Error('Missing authorization header');
            }
            const { authorization } = connectionParams;
            if (!authorization.startsWith('Bearer ')) {
              throw new Error('Malformed authorization token');
            }
            return { user: authorization.split('Bearer ')[1] };

          }
        },
      },
    }),
  ],
})
export class AppModule {}
