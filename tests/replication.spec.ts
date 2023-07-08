import { RxDatabase } from 'rxdb';
import { AxiosTransporter } from '../src/transporter';
import { initDatabase } from './database';
import { replicateOrion } from '../src';
import { executePull } from '../src/helpers';
import axios from 'axios';
import './replication.mock';

describe('Replication', () => {
  let database: RxDatabase;

  beforeEach(async () => {
    database = await initDatabase();
  });

  afterEach(async () => {
    await database.destroy();
  });

  it('Should execute pull request when schema has ref array properties', async () => {
    const http = axios.create({ baseURL: 'http://api.fake.pull' });
    const transporter = new AxiosTransporter(http);

    const result = await executePull({
      schema: database.collections.users.schema,
      baseUrl: { path: '/users' },
      batchSize: 3,
      wrap: 'data',
      transporter,
    });

    expect(result).toEqual([
      { id: '10', name: 'Jeff', roles: [{ id: '100', name: 'Admin' }] },
      { id: '11', name: 'Mark', roles: [{ id: '200', name: 'Editor' }] },
    ]);
  });

  it('Should execute push to remote server', async () => {
    const http = axios.create({ baseURL: 'http://api.fake.push' });
    const transporter = new AxiosTransporter(http);

    const users = database.collections.users;
    const replicationState = replicateOrion({
      url: '/users',
      collection: database.collections.users,
      transporter,
      batchSize: 3,
    });

    await replicationState.start();
    await replicationState.awaitInitialReplication();

    const request = jest.spyOn(transporter, 'execute').mockReturnValue(
      Promise.resolve({
        id: 1,
      })
    );

    await users.insert({
      id: '1',
      name: 'Marx',
      roles: ['100', '200'],
    });

    await replicationState.awaitInSync();
    await replicationState.cancel();

    expect(request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: { id: '1', name: 'Marx' },
        method: 'POST',
        path: '/users',
      })
    );

    expect(request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: { 'resources': ['100', '200'] },
        method: 'PATCH',
        path: '/users/1/roles/sync',
      })
    );
  });
});
