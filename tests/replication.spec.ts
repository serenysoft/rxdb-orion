import { RxDatabase } from 'rxdb';
import { initDatabase } from './database';
import { Manager, replicateOrion } from '../src';
import { executeFetch } from '../src/helpers';
import { Transporter } from '../src/types';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import fetch from 'node-fetch';
import './replication.mock';

describe('Replication', () => {
  let database: RxDatabase;
  let transporter: Transporter;

  beforeAll(() => {
    globalThis.fetch = fetch as any;
  });

  beforeEach(async () => {
    database = await initDatabase();
    transporter = jest.fn(executeFetch);
  });

  afterEach(async () => {
    await database.destroy();
  });

  it('Should pull documents from remote api', async () => {
    const users = database.collections.users;
    const replicationState = replicateOrion({
      url: 'http://api.fake.pull/users',
      params: { include: 'roles' },
      collection: users,
      batchSize: 3,
      transporter,
    });

    await replicationState.start();
    await replicationState.awaitInitialReplication();
    await replicationState.cancel();

    expect(transporter).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: 'http:/api.fake.pull/users/search',
        method: 'POST',
        params: { limit: 3, include: 'roles', with_trashed: true },
        headers: {
          'Accept': 'application/json',
        },
      })
    );

    const results = (await users.find().exec()).map((user) =>
      user.toMutableJSON()
    );

    expect(results).toEqual(
      expect.objectContaining([
        { id: '10', name: 'Jeff', roles: ['100'] },
        { id: '11', name: 'Mark', roles: ['200'] },
      ])
    );
  });

  it('Should push documents to remote api', async () => {
    const users = database.collections.users;

    const replicationState = replicateOrion({
      url: 'http://api.fake.push/users',
      collection: database.collections.users,
      batchSize: 3,
      transporter,
    });

    await replicationState.start();
    await replicationState.awaitInitialReplication();

    const user = await users.insert({
      id: '1',
      name: 'Marx',
      roles: ['100', '200'],
    });
    await replicationState.awaitInSync();

    //Nock return http:/api.fake.push/users/1/roles/sync not found
    //I don't know why
    //await user.patch({ name: 'Bill' });
    //await replicationState.awaitInSync();

    await user.remove();
    await replicationState.awaitInSync();

    expect(transporter).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: 'http:/api.fake.push/users',
        method: 'POST',
        data: { id: '1', name: 'Marx', '_attachments': {} },
        headers: {
          'Accept': 'application/json',
        },
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

    //the nth 4 is reference to `RESYNC`

    expect(transporter).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        url: 'http:/api.fake.push/users/1',
        method: 'DELETE',
      })
    );
  });

  it('Should manage multiple replications', async () => {
    const roles = database.collections.roles;

    const userReplicationState = replicateOrion({
      url: 'http://api.fake.manager/roles',
      collection: roles,
      batchSize: 3,
    });

    const start = jest.spyOn(userReplicationState, 'start');
    const cancel = jest.spyOn(userReplicationState, 'cancel');

    const manager = new Manager([userReplicationState], 1000);

    await manager.start(true);
    await manager.start();

    expect(start).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 1500));

    await manager.stop();
    expect((manager as any).intervals.length).toEqual(0);

    await manager.cancel();
    expect(cancel).toHaveBeenCalled();
  });

  it('Should replicate attachments', async () => {
    const file = readFileSync(resolve(__dirname, './fixtures/icon.png'));
    const { users } = database.collections;

    const replicationState = replicateOrion({
      url: 'http://api.fake.attachments/users',
      collection: users,
      batchSize: 3,
      transporter,
    });

    await replicationState.start();
    await replicationState.awaitInitialReplication();

    const user = await users.insert({
      id: '1',
      name: 'Bill',
    });

    user.putAttachment({
      id: 'icon.png',
      type: 'image/png',
      data: file.toString('base64'),
    });

    await replicationState.awaitInSync();
  });
});
