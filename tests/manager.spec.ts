import { RxDatabase } from 'rxdb';
import { RxReplicationState } from 'rxdb/plugins/replication';
import { executeFetch } from '../src/helpers';
import { ManagerError, Transporter } from '../src/types';
import fetch from 'node-fetch';
import './replication.mock';
import { Manager, replicateOrion } from '../src';
import { initDatabase } from './database';

describe('Manager', () => {
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

  it('does not queue resyncs while a pull is blocked and resumes when idle', async () => {
    let releasePull!: () => void;
    let enteredPull!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enteredPull = resolve;
    });
    const state = replicateOrion({
      collection: database.collections.roles,
      url: '/roles',
      waitForLeadership: false,
      transporter: async () => {
        enteredPull();
        await blocked;
        return { data: [] };
      },
    });
    let releaseStart!: () => void;
    const starting = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const metaInfo = state.metaInfoPromise;
    const delayedStart = jest.replaceProperty(
      state,
      'metaInfoPromise',
      starting.then(() => metaInfo),
    );
    const manager = new Manager([state], 10);
    const resync = jest.spyOn(state, 'reSync');

    try {
      await manager.start();
      // Hold startup where wasStarted is true but the internal state is absent.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(state.wasStarted).toBe(true);
      expect(state.internalReplicationState).toBeUndefined();
      expect(resync).not.toHaveBeenCalled();
      releaseStart();
      await entered;
      // Accelerate the polling interval to reproduce a prolonged blocked request.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(resync).not.toHaveBeenCalled();
      releasePull();
      await manager.awaitInSync();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(resync).toHaveBeenCalled();
    } finally {
      releaseStart();
      releasePull();
      await manager.cancel();
      delayedStart.restore();
    }
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
});
