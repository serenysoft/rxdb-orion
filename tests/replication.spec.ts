import { RxDatabase } from 'rxdb';
import { RxReplicationState } from 'rxdb/plugins/replication';
import { initDatabase } from './database';
import { replicateOrion } from '../src';
import {
  executeFetch,
  executePull,
  executePush,
  extractArrayReferences,
} from '../src/helpers';
import { Transporter } from '../src/types';
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
