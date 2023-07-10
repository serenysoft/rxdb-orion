import { RxDatabase } from 'rxdb';
import { initDatabase } from './database';
import { replicateOrion } from '../src';
import { executeFetch } from '../src/helpers';
import fetch from 'node-fetch';
import './replication.mock';

describe('Replication', () => {
  let database: RxDatabase;

  beforeAll(() => {
    (globalThis as any).fetch = fetch;
  });

  beforeEach(async () => {
    database = await initDatabase();
  });

  afterEach(async () => {
    await database.destroy();
  });

  it('Should execute pull from remote api', async () => {
    const users = database.collections.users;
    const replicationState = replicateOrion({
      url: 'http://api.fake.pull/users',
      params: { include: 'roles' },
      collection: users,
      batchSize: 3,
    });

    await replicationState.start();
    await replicationState.awaitInitialReplication();
    await replicationState.cancel();

    const results = (await users.find().exec()).map((user) => user.toMutableJSON());

    expect(results).toEqual(
      expect.objectContaining([
        { id: '10', name: 'Jeff', roles: [{ id: '100', name: 'Admin' }] },
        { id: '11', name: 'Mark', roles: [{ id: '200', name: 'Editor' }] },
      ])
    );
  });

  it('Should execute push to remote api', async () => {
    const transporter = jest.fn(executeFetch);
    const users = database.collections.users;

    const replicationState = replicateOrion({
      url: 'http://api.fake.push/users',
      collection: database.collections.users,
      batchSize: 3,
      transporter,
    });

    await replicationState.start();
    await replicationState.awaitInitialReplication();

    await users.insert({
      id: '1',
      name: 'Marx',
      roles: ['100', '200'],
    });

    await replicationState.awaitInSync();
    await replicationState.cancel();

    expect(transporter).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: 'http:/api.fake.push/users',
        method: 'POST',
        data: { id: '1', name: 'Marx' },
      })
    );

    expect(transporter).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        url: 'http:/api.fake.push/users/1/roles/sync',
        method: 'PATCH',
        data: { 'resources': ['100', '200'] },
      })
    );
  });
});
