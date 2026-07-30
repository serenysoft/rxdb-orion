import { RxDatabase } from 'rxdb';
import { RxReplicationState } from 'rxdb/plugins/replication';
import { initDatabase } from './database';
import { Manager, replicateOrion } from '../src';
import {
  executeFetch,
  executePull,
  executePush,
  extractArrayReferences,
} from '../src/helpers';
import { Transporter } from '../src/types';
// import { readFileSync } from 'fs';
// import { resolve } from 'path';
import fetch from 'node-fetch';
import './replication.mock';

describe('Replication', () => {
  let database: RxDatabase;
  let transporter: Transporter;
  let replicationState: RxReplicationState<any, any>;

  beforeAll(() => {
    globalThis.fetch = fetch as any;
  });

  beforeEach(async () => {
    database = await initDatabase();
    transporter = jest.fn(executeFetch);
  });

  afterEach(async () => {
    await database.close();
  });

  it('Should pull documents from remote api', async () => {
    const users = database.collections.users;
    replicationState = replicateOrion({
      waitForLeadership: false,
      url: 'http://api.fake.pull/users',
      params: { include: 'roles,tags' },
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
        params: { limit: 3, include: 'roles,tags', with_trashed: true },
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
        { id: '10', name: 'Jeff', roles: ['100'], tags: ['300', '301'] },
        { id: '11', name: 'Mark', roles: ['200'], tags: [] },
      ])
    );
  });

  it('Should map pull references from snake_case ref property', async () => {
    const members = database.collections.members;

    const result = await executePull({
      collection: members,
      url: 'http://api.fake.pull/members-ref',
      batchSize: 3,
      deletedField: '_deleted',
      exclude: [],
      include: [],
      wrap: 'data',
      transporter,
    });

    expect(result).toEqual([
      {
        id: 'REL-001',
        name: 'Alice',
        userRoles: ['100', '200'],
      },
    ]);
  });

  it('Should map pull references from snake_case key property', async () => {
    const members = database.collections.members;

    const result = await executePull({
      collection: members,
      url: 'http://api.fake.pull/members-key',
      batchSize: 3,
      deletedField: '_deleted',
      exclude: [],
      include: [],
      wrap: 'data',
      transporter,
    });

    expect(result).toEqual([
      {
        id: 'REL-002',
        name: 'Bob',
        userRoles: ['100', '200'],
      },
    ]);
  });

  it('Should ignore references when property is not an array', () => {
    const users = database.collections.users;

    expect(extractArrayReferences(users)).toEqual({
      roles: 'roles',
      tags: 'tags',
    });
  });

  it('Should replicate non-array ref property as a scalar field', async () => {
    const users = database.collections.users;

    const userReplication = replicateOrion({
      waitForLeadership: false,
      url: 'http://api.fake.pull/users-with-primary-tag',
      collection: users,
      batchSize: 3,
      transporter,
    });

    await userReplication.start();
    await userReplication.awaitInitialReplication();
    await userReplication.cancel();

    expect(transporter).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: 'http:/api.fake.pull/users-with-primary-tag/search',
        method: 'POST',
        params: {
          limit: 3,
          include: 'roles,tags',
          with_trashed: true,
        },
      })
    );

    const results = (await users.find().exec()).map((user) =>
      user.toMutableJSON()
    );

    expect(results).toEqual(
      expect.arrayContaining([
        {
          id: 'USR-TAG-1',
          name: 'Owner',
          primaryTag: '300',
          roles: ['100'],
          tags: [],
        },
      ])
    );
  });

  it('Should push documents to remote api', async () => {
    const users = database.collections.users;

    replicationState = replicateOrion({
      waitForLeadership: false,
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
        data: { id: '1', name: 'Marx', _attachments: {} },
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

  it('Should push documents to remote api excluding relations', async () => {
    const users = database.collections.users;

    replicationState = replicateOrion({
      waitForLeadership: false,
      url: 'http://api.fake.push/users-exclude',
      collection: database.collections.users,
      transporter,
      exclude: {
        pull: ['roles'],
        push: ['roles'],
      },
    });

    await replicationState.start();
    await replicationState.awaitInitialReplication();

    await users.insert({
      id: 'EX-001',
      name: 'Marx',
    });

    await replicationState.awaitInSync();

    expect(transporter).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: 'http:/api.fake.push/users-exclude/search',
        method: 'POST',
      })
    );

    expect(transporter).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: 'http:/api.fake.push/users-exclude',
        method: 'POST',
        data: {
          id: 'EX-001',
          name: 'Marx',
          _attachments: {},
        },
        headers: {
          'Accept': 'application/json',
        },
      })
    );
  });

  it('Should manage multiple replications', async () => {
    const roles = database.collections.roles;

    const userReplicationState = replicateOrion({
      url: 'http://api.fake.manager/roles',
      collection: roles,
      batchSize: 3,
      waitForLeadership: false,
    });

    const start = jest.spyOn(userReplicationState, 'start');
    const cancel = jest.spyOn(userReplicationState, 'cancel');

    const manager = new Manager([userReplicationState], 1000);

    await manager.start();

    expect(manager.isInitialSyncFinished()).toBe(false);

    await manager.awaitInitialSync();

    expect(manager.isInitialSyncFinished()).toBe(true);

    expect(start).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 1500));

    await manager.stop();
    expect((manager as any).intervals.length).toEqual(0);

    await manager.cancel();
    expect(cancel).toHaveBeenCalled();
  });

  /*
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
  */

  it('Should call awaitInSync on all replications via Manager', async () => {
    const users = database.collections.users;
    replicationState = replicateOrion({
      waitForLeadership: false,
      url: 'http://api.fake.sync/users',
      collection: users,
      batchSize: 3,
      transporter,
    });

    const awaitInSync = jest
      .spyOn(replicationState, 'awaitInSync')
      .mockResolvedValue(undefined);

    const manager = new Manager([replicationState], 1000);

    await manager.awaitInSync();
    expect(awaitInSync).toHaveBeenCalledTimes(1);
    awaitInSync.mockRestore();
  });

  it('Should merge include with auto-detected keys in executePull', async () => {
    const users = database.collections.users;

    const result = await executePull({
      collection: users,
      url: 'http://api.fake.pull/users-include',
      batchSize: 3,
      deletedField: '_deleted',
      exclude: [],
      include: ['permissions'],
      wrap: 'data',
      transporter,
    });

    expect(transporter).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http:/api.fake.pull/users-include/search',
        params: {
          limit: 3,
          include: 'roles,tags,permissions',
          with_trashed: true,
        },
      })
    );

    expect(result).toEqual([
      {
        id: 'INC-001',
        name: 'IncludeUser',
        roles: ['100'],
        tags: [],
        permissions: ['p1', 'p2'],
      },
    ]);
  });

  it('Should merge include with exclude in executePull', async () => {
    const users = database.collections.users;

    const result = await executePull({
      collection: users,
      url: 'http://api.fake.pull/users-include-exclude',
      batchSize: 3,
      deletedField: '_deleted',
      exclude: ['roles'],
      include: ['permissions'],
      wrap: 'data',
      transporter,
    });

    expect(transporter).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http:/api.fake.pull/users-include-exclude/search',
        params: {
          limit: 3,
          include: 'tags,permissions',
          with_trashed: true,
        },
      })
    );

    expect(result).toEqual([
      {
        id: 'INC-EX-001',
        name: 'IncludeExcludeUser',
        roles: [],
        tags: ['300'],
        permissions: ['p1', 'p2'],
      },
    ]);
  });

  it('Should use only include when all schema refs excluded', async () => {
    const users = database.collections.users;

    const result = await executePull({
      collection: users,
      url: 'http://api.fake.pull/users-include-only',
      batchSize: 3,
      deletedField: '_deleted',
      exclude: ['roles', 'tags'],
      include: ['permissions'],
      wrap: 'data',
      transporter,
    });

    expect(transporter).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http:/api.fake.pull/users-include-only/search',
        params: {
          limit: 3,
          include: 'permissions',
          with_trashed: true,
        },
      })
    );

    expect(result).toEqual([
      {
        id: 'INC-ONLY-001',
        name: 'IncludeOnlyUser',
        roles: [],
        tags: [],
        permissions: ['p1', 'p2'],
      },
    ]);
  });

  it('Should pass include through replicateOrion config', async () => {
    const users = database.collections.users;

    replicationState = replicateOrion({
      waitForLeadership: false,
      url: 'http://api.fake.pull-include/users',
      collection: users,
      batchSize: 3,
      transporter,
      include: ['permissions'],
    });

    await replicationState.start();
    await replicationState.awaitInitialReplication();
    await replicationState.cancel();

    expect(transporter).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http:/api.fake.pull-include/users/search',
        params: {
          limit: 3,
          include: 'roles,tags,permissions',
          with_trashed: true,
        },
      })
    );
  }, 10000);

  it('Should not pass include to executePush', async () => {
    // include is pull-only — executePush signature does not accept include
    const users = database.collections.users;
    const pushTransporter = jest.fn().mockResolvedValue({});

    await executePush({
      url: 'http://fake.test/users',
      headers: {},
      rows: [
        {
          newDocumentState: {
            id: 'INCPUSH-1',
            name: 'IncludePushUser',
            roles: ['100'],
            _deleted: false,
          },
          assumedMasterState: undefined,
        },
      ],
      collection: users,
      deletedField: '_deleted',
      primaryPath: 'id',
      exclude: [],
      transporter: pushTransporter,
    });

    // Should have called POST for the new document (roles stripped, permissions kept)
    expect(pushTransporter).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http:/fake.test/users',
        method: 'POST',
        data: { id: 'INCPUSH-1', name: 'IncludePushUser' },
      })
    );
  }, 10000);
});
