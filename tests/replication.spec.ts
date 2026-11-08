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
import { ManagerError, Transporter } from '../src/types';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import fetch from 'node-fetch';
import './replication.mock';

describe('Replication', () => {
  let database: RxDatabase;
  let transporter: Transporter;
  let replicationState: RxReplicationState<any, any> | undefined;

  beforeAll(() => {
    globalThis.fetch = fetch as any;
  });

  beforeEach(async () => {
    database = await initDatabase();
    transporter = jest.fn(executeFetch);
  });

  afterEach(async () => {
    if (replicationState) {
      await replicationState.cancel();
      replicationState = undefined;
    }
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
      }),
    );

    const results = (await users.find().exec()).map((user) =>
      user.toMutableJSON(),
    );

    expect(results).toEqual([
      { id: '10', name: 'Jeff', roles: ['100'], tags: ['300', '301'] },
      { id: '11', name: 'Mark', roles: ['200'], tags: [] },
    ]);
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
      }),
    );

    const results = (await users.find().exec()).map((user) =>
      user.toMutableJSON(),
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
      ]),
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
      }),
    );

    expect(transporter).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        url: 'http:/api.fake.push/users/1/roles/sync',
        method: 'PATCH',
        data: { 'resources': ['100', '200'] },
      }),
    );

    //the nth 4 is reference to `RESYNC`

    expect(transporter).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        url: 'http:/api.fake.push/users/1',
        method: 'DELETE',
      }),
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
      }),
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
      }),
    );
  });

  it('Should start dependencies before dependents and order pushes', async () => {
    const roles = database.collections.roles;
    const users = database.collections.users;

    const order: string[] = [];

    const rolesState = replicateOrion({
      url: 'http://api.fake.deps/roles',
      collection: roles,
      batchSize: 3,
      waitForLeadership: false,
      transporter: async (request: any) => {
        order.push(`${request.url} ${request.method}`);
        return request.url.includes('/search') ? { data: [] } : { data: {} };
      },
    });

    const usersState = replicateOrion({
      url: 'http://api.fake.deps/users',
      collection: users,
      batchSize: 3,
      waitForLeadership: false,
      dependsOn: [rolesState],
      transporter: async (request: any) => {
        order.push(`${request.url} ${request.method}`);
        return request.url.includes('/search') ? { data: [] } : { data: {} };
      },
    });

    const manager = new Manager([usersState, rolesState], 1000);

    await manager.start();
    await manager.awaitInitialSync();

    // Initial sync of the dependency must finish before the dependent starts.
    const rolesSearch = order.findIndex(
      (entry) => entry === 'http:/api.fake.deps/roles/search POST',
    );
    const usersSearch = order.findIndex(
      (entry) => entry === 'http:/api.fake.deps/users/search POST',
    );

    expect(rolesSearch).toBeGreaterThanOrEqual(0);
    expect(usersSearch).toBeGreaterThan(rolesSearch);

    // Live pushes of the dependency must finish before the dependent pushes.
    order.length = 0;

    await roles.insert({ id: 'R-DEP', name: 'Child' });
    await users.insert({ id: 'U-DEP', name: 'Parent', roles: [] });

    await manager.awaitInSync();

    const pushOrder = order
      .filter((entry) => entry.endsWith(' POST') && !entry.includes('/search'))
      .map((entry) => entry.replace(/ POST$/, ''));

    expect(pushOrder).toEqual([
      'http:/api.fake.deps/roles',
      'http:/api.fake.deps/users',
    ]);

    await manager.stop();
    await manager.cancel();
  }, 15000);

  it('Should wait for child pushes even when the parent is resynced', async () => {
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let childStarted!: () => void;
    const childPending = new Promise<void>((resolve) => {
      childStarted = resolve;
    });
    const order: string[] = [];
    const child = replicateOrion({
      collection: database.roles,
      url: 'http://fake/roles',
      waitForLeadership: false,
      transporter: async (request) => {
        if (request.url.endsWith('/search')) return { data: [] };
        childStarted();
        await childGate;
        order.push('child');
        return { data: {} };
      },
    });
    const parent = replicateOrion({
      collection: database.users,
      url: 'http://fake/users',
      waitForLeadership: false,
      dependsOn: [child],
      transporter: async (request) => {
        if (request.url.endsWith('/search')) return { data: [] };
        order.push('parent');
        return { data: {} };
      },
    });
    const manager = new Manager([parent, child], 20);
    try {
      await manager.start();
      await manager.awaitInitialSync();
      await database.roles.insert({ id: 'child', name: 'Child' });
      await childPending;
      await database.users.insert({ id: 'parent', name: 'Parent', roles: [] });
      parent.reSync();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(order).toEqual([]);
      releaseChild();
      await manager.awaitInSync();
      expect(order).toEqual(['child', 'parent']);
    } finally {
      releaseChild();
      await manager.cancel();
    }
  });

  it('Should sync independent collections and resume polling during pending initialization', async () => {
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const child = replicateOrion({
      collection: database.roles,
      url: 'http://fake/roles',
      waitForLeadership: false,
      transporter: async () => {
        await childGate;
        return { data: [] };
      },
    });
    const parent = replicateOrion({
      collection: database.users,
      url: 'http://fake/users',
      waitForLeadership: false,
      dependsOn: [child],
      transporter: async () => ({ data: [] }),
    });
    const independent = replicateOrion({
      collection: database.tags,
      url: 'http://fake/tags',
      waitForLeadership: false,
      transporter: async () => ({ data: [] }),
    });
    const resync = jest.spyOn(independent, 'reSync');
    const startChild = jest.spyOn(child, 'start');
    const manager = new Manager([parent, child, independent], 20);
    try {
      await manager.start();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(independent.wasStarted).toBe(true);
      expect(parent.wasStarted).toBe(false);
      expect(resync).toHaveBeenCalled();
      expect(startChild).toHaveBeenCalledTimes(1);
      await manager.stop();
      resync.mockClear();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(resync).not.toHaveBeenCalled();
      await manager.start();
      releaseChild();
      await manager.awaitInitialSync();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(resync).toHaveBeenCalled();
      expect(startChild).toHaveBeenCalledTimes(1);
    } finally {
      releaseChild();
      await manager.cancel();
    }
  });

  it('Should not push a canceled parent when its dependency finishes', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const child = replicateOrion({
      collection: database.roles,
      url: 'http://fake/roles',
      waitForLeadership: false,
      transporter: async (request) => {
        if (!request.url.endsWith('/search')) await pending;
        return { data: request.url.endsWith('/search') ? [] : {} };
      },
    });
    const pushes = jest.fn();
    const parent = replicateOrion({
      collection: database.users,
      url: 'http://fake/users',
      waitForLeadership: false,
      dependsOn: [child],
      transporter: async (request) => {
        if (!request.url.endsWith('/search')) pushes();
        return { data: request.url.endsWith('/search') ? [] : {} };
      },
    });
    const manager = new Manager([parent, child], 20);
    try {
      await manager.start();
      await manager.awaitInitialSync();
      await database.roles.insert({ id: 'cancel-child', name: 'Child' });
      await database.users.insert({
        id: 'cancel-parent',
        name: 'Parent',
        roles: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await parent.cancel();
      // Cancellation must release the parent's queue even while the child waits.
      await parent.internalReplicationState!.streamQueue.up;
      release();
      await child.awaitInSync();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(pushes).not.toHaveBeenCalled();
      expect(
        await database.users.findOne('cancel-parent').exec(),
      ).not.toBeNull();
    } finally {
      release();
      await manager.cancel();
    }

    const name = database.name;
    await database.close();
    database = await initDatabase(name);
    const recoveredChild = replicateOrion({
      collection: database.roles,
      url: 'http://fake/roles',
      waitForLeadership: false,
      transporter: async () => ({ data: [] }),
    });
    const recoveredParent = replicateOrion({
      collection: database.users,
      url: 'http://fake/users',
      waitForLeadership: false,
      dependsOn: [recoveredChild],
      transporter: async (request) => {
        if (!request.url.endsWith('/search')) pushes(request.data.id);
        return { data: request.url.endsWith('/search') ? [] : {} };
      },
    });
    const recoveredManager = new Manager([recoveredParent, recoveredChild], 20);
    try {
      await recoveredManager.start();
      await recoveredManager.awaitInitialSync();
      expect(pushes).toHaveBeenCalledTimes(1);
      expect(pushes).toHaveBeenCalledWith('cancel-parent');
    } finally {
      await recoveredManager.cancel();
    }
  });

  it('Should keep the parent pending through repeated dependency failures', async () => {
    let online = false;
    let attempts = 0;
    const order: string[] = [];
    const child = replicateOrion({
      collection: database.roles,
      url: 'http://fake/roles',
      waitForLeadership: false,
      retryTime: 20,
      transporter: async (request) => {
        if (request.url.endsWith('/search')) return { data: [] };
        attempts++;
        if (!online) throw new Error('Offline');
        order.push('child');
        return { data: {} };
      },
    });
    const parent = replicateOrion({
      collection: database.users,
      url: 'http://fake/users',
      waitForLeadership: false,
      dependsOn: [child],
      transporter: async (request) => {
        if (request.url.endsWith('/search')) return { data: [] };
        order.push('parent');
        return { data: {} };
      },
    });
    const manager = new Manager([parent, child], 20);
    const errors = jest.fn();
    const subscription = manager.errors$.subscribe(errors);
    try {
      await manager.start();
      await manager.awaitInitialSync();
      await database.roles.insert({ id: 'retry-child', name: 'Child' });
      await database.users.insert({
        id: 'retry-parent',
        name: 'Parent',
        roles: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(attempts).toBeGreaterThan(1);
      expect(errors).toHaveBeenCalled();
      expect(order).toEqual([]);
      online = true;
      await manager.awaitInSync();
      expect(order).toEqual(['child', 'parent']);
    } finally {
      online = true;
      subscription.unsubscribe();
      await manager.cancel();
    }
  });

  it('Should report circular dependencies without completing initial sync', async () => {
    const dependencies: RxReplicationState<any, any>[] = [];
    const transporter = jest.fn(async (): Promise<{ data: unknown[] }> => ({
      data: [],
    }));
    const child = replicateOrion({
      collection: database.roles,
      url: 'http://fake/roles',
      waitForLeadership: false,
      dependsOn: dependencies,
      transporter,
    });
    const parent = replicateOrion({
      collection: database.users,
      url: 'http://fake/users',
      waitForLeadership: false,
      dependsOn: [child],
      transporter,
    });
    dependencies.push(parent);
    const manager = new Manager([parent, child], 20);
    const errors = jest.fn();
    const subscription = manager.errors$.subscribe(errors);
    try {
      await manager.start();
      await expect(manager.awaitInitialSync()).rejects.toThrow(
        'Circular dependency',
      );
      expect(manager.isInitialSyncFinished()).toBe(false);
      expect(errors).toHaveBeenCalled();
      expect(transporter).not.toHaveBeenCalled();
    } finally {
      subscription.unsubscribe();
      await manager.cancel();
    }
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

  it('Should push documents with attachments', async () => {
    const file = readFileSync(resolve(__dirname, './fixtures/icon.png'));
    const users = database.collections.users;

    const replicationState = replicateOrion({
      url: 'http://api.fake.push-attachments/users',
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

    await replicationState.awaitInSync();

    // A new document has no assumed master state and must be inserted.
    expect(transporter).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: 'http:/api.fake.push-attachments/users',
        method: 'POST',
        data: { id: '1', name: 'Bill', _attachments: {} },
        headers: { 'Accept': 'application/json' },
      }),
    );

    await user.putAttachment({
      id: 'icon.png',
      type: 'image/png',
      data: file.toString('base64'),
    });

    await replicationState.awaitInSync();

    // Verify the push sent base64 data for the attachment
    const base64Data = file.toString('base64');
    expect(transporter).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        url: 'http:/api.fake.push-attachments/users/1',
        method: 'PUT',
        data: expect.objectContaining({
          id: '1',
          name: 'Bill',
          _attachments: expect.objectContaining({
            'icon.png': expect.objectContaining({
              type: 'image/png',
              data: base64Data,
            }),
          }),
        }),
        headers: { 'Accept': 'application/json' },
      }),
    );

    // Verify the attachment is still accessible locally
    const doc = await users.findOne('1').exec();
    expect(doc).toBeDefined();
    const attachment = doc.getAttachment('icon.png');
    expect(attachment).toBeDefined();
    expect(attachment.id).toBe('icon.png');
    expect(attachment.type).toBe('image/png');

    await replicationState.cancel();
  });

  it('Should pull documents with attachments', async () => {
    const users = database.collections.users;

    replicationState = replicateOrion({
      waitForLeadership: false,
      url: 'http://api.fake.pull-attachments/users',
      collection: users,
      batchSize: 3,
      transporter,
    });

    await replicationState.start();
    await replicationState.awaitInitialReplication();
    await replicationState.cancel();

    // Verify pull request was made
    expect(transporter).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http:/api.fake.pull-attachments/users/search',
        method: 'POST',
        headers: { 'Accept': 'application/json' },
      }),
    );

    // Verify pulled documents were stored with attachments accessible
    const doc1 = await users.findOne('ATT-001').exec();
    expect(doc1).toBeDefined();
    expect(doc1.get('name')).toBe('AttachmentUser');

    const file = doc1.getAttachment('file.txt');
    expect(file).toBeDefined();
    expect(file.id).toBe('file.txt');
    expect(file.type).toBe('text/plain');

    // Verify second doc: multiple attachments
    const doc2 = await users.findOne('ATT-002').exec();
    expect(doc2).toBeDefined();
    expect(doc2.get('name')).toBe('MultiAttachmentUser');

    const notes = doc2.getAttachment('notes.md');
    expect(notes).toBeDefined();
    expect(notes.id).toBe('notes.md');
    expect(notes.type).toBe('text/markdown');

    const image = doc2.getAttachment('image.png');
    expect(image).toBeDefined();
    expect(image.id).toBe('image.png');
    expect(image.type).toBe('image/png');
  });

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

  it('Should emit replication errors via the Manager errors$ event', async () => {
    const users = database.collections.users;
    const failingTransporter = jest
      .fn()
      .mockRejectedValue(new Error('Network error'));

    const failingReplication = replicateOrion({
      url: 'http://api.fake.error/users',
      collection: users,
      batchSize: 3,
      retryTime: 100,
      waitForLeadership: false,
      transporter: failingTransporter,
    });

    const manager = new Manager([failingReplication], 1000);

    const firstError = new Promise<ManagerError>((resolve) => {
      const subscription = manager.errors$.subscribe((event) => {
        resolve(event);
        subscription.unsubscribe();
      });
    });

    await manager.start();

    let timeoutId: NodeJS.Timeout | undefined;
    const event = await Promise.race([
      firstError,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('No error emitted')),
          5000,
        );
      }),
    ]).finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });

    expect(event.replicationState).toBe(failingReplication);
    expect(event.error).toBeInstanceOf(Error);
    expect((event.error as any).code).toBe('RC_PULL');

    await manager.stop();
    await manager.cancel();
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
      }),
    );

    expect(result).toEqual([
      {
        id: 'INC-001',
        name: 'IncludeUser',
        _attachments: {},
        roles: ['100'],
        tags: [],
        permissions: [{ id: 'p1' }, { id: 'p2' }],
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
      }),
    );

    expect(result).toEqual([
      {
        id: 'INC-EX-001',
        name: 'IncludeExcludeUser',
        _attachments: {},
        roles: [],
        tags: ['300'],
        permissions: [{ id: 'p1' }, { id: 'p2' }],
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
      }),
    );

    expect(result).toEqual([
      {
        id: 'INC-ONLY-001',
        name: 'IncludeOnlyUser',
        _attachments: {},
        roles: [],
        tags: [],
        permissions: [{ id: 'p1' }, { id: 'p2' }],
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
      }),
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
      }),
    );
  }, 10000);

  it('Should keep pushing when a delete was not found on remote api', async () => {
    const users = database.collections.users;

    const pushTransporter = jest
      .fn<ReturnType<Transporter>, Parameters<Transporter>>()
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce({});

    const conflicts = await executePush({
      url: 'http://api.fake.push-not-found/users',
      headers: {},
      rows: [
        {
          assumedMasterState: { id: '1', name: 'Jeff' } as any,
          newDocumentState: { id: '1', name: 'Jeff', _deleted: true } as any,
        },
        {
          assumedMasterState: undefined,
          newDocumentState: { id: '2', name: 'Bill', _deleted: false } as any,
        },
      ],
      collection: users,
      deletedField: '_deleted',
      primaryPath: 'id',
      exclude: [],
      transporter: pushTransporter,
    });

    expect(conflicts).toEqual([]);
    expect(pushTransporter).toHaveBeenCalledTimes(2);

    expect(pushTransporter).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: 'http:/api.fake.push-not-found/users/1',
        method: 'DELETE',
      }),
    );

    expect(pushTransporter).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        url: 'http:/api.fake.push-not-found/users',
        method: 'POST',
      }),
    );
  });

  it('Should resolve a vanished master row as a delete conflict', async () => {
    const users = database.collections.users;

    const pushTransporter = jest
      .fn<ReturnType<Transporter>, Parameters<Transporter>>()
      .mockRejectedValue({ response: { status: 404 } });

    const conflicts = await executePush({
      url: 'http://api.fake.push-not-found/users',
      headers: {},
      rows: [
        {
          assumedMasterState: { id: '1', name: 'Jeff' } as any,
          newDocumentState: { id: '1', name: 'Bill', _deleted: false } as any,
        },
      ],
      collection: users,
      deletedField: '_deleted',
      primaryPath: 'id',
      exclude: [],
      transporter: pushTransporter,
    });

    expect(conflicts).toEqual([
      { id: '1', name: 'Bill', _deleted: true, _attachments: {} },
    ]);
  });

  it('Should still fail when a create is not found on remote api', async () => {
    const users = database.collections.users;
    const notFound = { response: { status: 404 } };

    const pushTransporter = jest
      .fn<ReturnType<Transporter>, Parameters<Transporter>>()
      .mockRejectedValue(notFound);

    await expect(
      executePush({
        url: 'http://api.fake.push-not-found/users',
        headers: {},
        rows: [
          {
            assumedMasterState: undefined,
            newDocumentState: { id: '2', name: 'Bill', _deleted: false } as any,
          },
        ],
        collection: users,
        deletedField: '_deleted',
        primaryPath: 'id',
        exclude: [],
        transporter: pushTransporter,
      }),
    ).rejects.toEqual(notFound);
  });

  it('Should use the row error classifier provided in the options', async () => {
    const users = database.collections.users;

    const pushTransporter = jest
      .fn<ReturnType<Transporter>, Parameters<Transporter>>()
      .mockRejectedValueOnce({ statusCode: 410 });

    const conflicts = await executePush({
      url: 'http://api.fake.push-not-found/users',
      headers: {},
      rows: [
        {
          assumedMasterState: { id: '1', name: 'Jeff' } as any,
          newDocumentState: { id: '1', name: 'Jeff', _deleted: true } as any,
        },
      ],
      collection: users,
      deletedField: '_deleted',
      primaryPath: 'id',
      exclude: [],
      rowError: (error) =>
        (error as { statusCode?: number })?.statusCode === 410,
      transporter: pushTransporter,
    });

    expect(conflicts).toEqual([]);
    expect(pushTransporter).toHaveBeenCalledTimes(1);
  });

  it('Should keep failing a delete when the classifier rejects the error', async () => {
    const users = database.collections.users;
    const notFound = { response: { status: 404 } };

    const pushTransporter = jest
      .fn<ReturnType<Transporter>, Parameters<Transporter>>()
      .mockRejectedValue(notFound);

    await expect(
      executePush({
        url: 'http://api.fake.push-not-found/users',
        headers: {},
        rows: [
          {
            assumedMasterState: { id: '1', name: 'Jeff' } as any,
            newDocumentState: { id: '1', name: 'Jeff', _deleted: true } as any,
          },
        ],
        collection: users,
        deletedField: '_deleted',
        primaryPath: 'id',
        exclude: [],
        rowError: () => false,
        transporter: pushTransporter,
      }),
    ).rejects.toEqual(notFound);
  });

  it('Should remove the local document when an update is not found on remote api', async () => {
    const users = database.collections.users;
    let searches = 0;

    const notFoundTransporter: Transporter = async (request) => {
      if (request.url?.endsWith('/search')) {
        searches += 1;

        return {
          data: searches === 1 ? [{ id: 'CF-1', name: 'Jeff', roles: [] }] : [],
        };
      }

      if (request.method === 'PUT') {
        throw { response: { status: 404 } };
      }

      return {};
    };

    const state = replicateOrion({
      waitForLeadership: false,
      url: 'http://api.fake.conflict/users',
      collection: users,
      transporter: notFoundTransporter,
    });

    await state.start();
    await state.awaitInitialReplication();

    const user = await users.findOne('CF-1').exec();
    expect(user).not.toBeNull();

    await user!.patch({ name: 'Bill' });
    await state.awaitInSync();

    expect(await users.findOne('CF-1').exec()).toBeNull();

    await state.cancel();
  }, 20000);
});
